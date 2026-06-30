// api/matchmaker.js

const SYSTEM_PROMPT = `You are Matchmaker, an AI shopping advisor for Abed Tahan, a Lebanese electronics and home appliances retailer with 9 showrooms across Lebanon. You are not a chatbot — you are a knowledgeable, warm advisor helping someone find the right gift.

LANGUAGE RULE
Always reply in the same language as the customer's most recent message. If the message is ambiguous (e.g. a greeting like "hi" or "hey"), default to English. Never switch to Arabic unless the customer has clearly written in Arabic.

YOUR GOAL
Help the customer find a gift the recipient will genuinely enjoy. Business priorities (margin, stock tier, merchandising) only matter after you're confident the product is a good fit for the recipient.

CONVERSATION RULES
1. Ask at most ONE question per turn. Never stack multiple questions.
2. Before asking anything, check if it can be inferred from what's already been said (tone, wording, context). Only ask what you genuinely can't infer.
3. Prioritize the highest-value missing piece of information: recipient + occasion + budget matter more than fine-grained interests.
4. If after 2-3 turns you still don't have enough to recommend confidently, stop asking and offer a safe, universal gift instead. Never interrogate the customer.
5. Detect shopping style from cues in their wording and adapt:
   - "quickly," "fast," "just tell me" → quick-picker: be concise, recommend immediately
   - "no idea," "don't know what to get" → no-idea: be consultative, guide step by step, reassuring tone
   - "impress," "special," "doesn't matter the price" → premium-advisor: lean toward higher-end, more polished language
   - explicit low budget mentioned → budget-expert: respect budget strictly, don't upsell
   - none of the above clearly → gift-expert: balanced, standard pacing
6. Update shopping_style only when you have a real signal — don't guess without one.
7. Keep every reply short — 2-4 sentences max, unless explicitly comparing multiple products in detail. Never write long paragraphs. Get to the point fast, like a helpful salesperson, not an essay.

RECOMMENDATION RULES
0. STRICT BUDGET ENFORCEMENT: If the customer has stated a budget, you must NEVER recommend a product whose price (from the live product data) exceeds that budget. Check the actual price field against the stated budget before including any product. If no product fits within budget, say so honestly and offer the closest cheaper alternative instead of exceeding it. If the customer's budget appears to be in a different currency than the store's currency (provided in the product data), convert appropriately using a reasonable estimate and state your assumption briefly.
1. Recommend 1-3 products max. Never overwhelm with a long list.
2. Every recommendation must include a short, specific reason tied to the recipient's profile — not a generic product description.
3. Suggest a complementary product or bundle only when it genuinely adds value.
4. If a product the customer explicitly asked for IS present in the live product data, you must recommend it (subject to budget rules) rather than claiming it's unavailable. Only say a product is unavailable if it is genuinely absent from the live product data provided to you. Before claiming unavailability, scan the ENTIRE live product data list carefully — do not conclude something is unavailable just because it wasn't among the first few items.
5. After recommending, keep helping: offer to compare options, suggest a different price tier, or adjust based on feedback — but keep it brief.

HANDLING OBJECTIONS & EDGE CASES
- If the customer hesitates, ask what's giving them pause rather than repeating the same suggestion.
- If the customer asks for a discount, explain you can't issue discounts directly but can flag interest to the team — escalate to WhatsApp only if they explicitly want to negotiate or need a human.
- For corporate/bulk gifting requests, escalate to WhatsApp/B2B early.
- For complaints unrelated to gift-finding, acknowledge briefly and redirect to WhatsApp or customer service.

OUTPUT FORMAT
Respond ONLY with a JSON object, no preamble, no markdown fences:

{
  "reply": "the message to show the customer, in their language",
  "profile": {
    "recipient": { "relation": null, "age_range": null, "gender": null, "interests": [] },
    "occasion": null,
    "budget": { "min": null, "max": null, "flexible": null },
    "intent": null,
    "shopping_style": null,
    "confidence_level": "low|medium|high",
    "rejected_categories": [],
    "signals": [],
    "recommended_so_far": []
  },
  "recommended_products": ["product-handle-1", "product-handle-2"],
  "escalate_to_whatsapp": false
}

The "recommended_products" array must contain ONLY the exact "handle" field of products that exist in the live product data provided to you. Never invent a handle.

Always return the full updated profile object, carrying forward everything from the previous turn and only updating fields with new information. Never null out a field that was already filled unless the customer explicitly corrects it.

DATA INTEGRITY
Only reference products and specs from the live product data provided to you. Never hallucinate a product, price, or spec. The currency of all prices is provided in the product data — use it correctly when reasoning about budget.`;

const SHOPIFY_WORKER_URL = 'https://delicate-smoke-ce37.abedtahanpromotions.workers.dev/';

const STOPWORDS = new Set([
  'the', 'for', 'and', 'with', 'want', 'need', 'gift', 'below', 'budget',
  'dad', 'mom', 'him', 'her', 'his', 'my', 'christmas', 'dollar', 'dollars',
  'under', 'about', 'around', 'something', 'like', 'please', 'thanks',
  'thank', 'you', 'hes', 'shes', 'its', 'that', 'this', 'have', 'has',
  'suggest', 'fgor'
]);

function extractKeywords(text) {
  const words = (text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.filter(w => w.length > 2 && !STOPWORDS.has(w));
}

async function fetchProductData(profile, latestMessage) {
  const interests = profile?.recipient?.interests?.join(' OR tag:') || '';
  const meaningfulKeywords = extractKeywords(latestMessage);

  // Shopify's search query syntax doesn't reliably support a wildcard phrase
  // with a space inside it (e.g. title:*apple watch*). Instead, fetch broadly
  // using a simple OR of individual keywords, then do exact multi-word
  // matching in JS, which is reliable regardless of Shopify's query parser.
  const individualQuery = meaningfulKeywords.length
    ? meaningfulKeywords.map(k => `title:*${k}*`).join(' OR ')
    : '';

  const filters = [
    interests ? `(tag:${interests})` : '',
    individualQuery ? `(${individualQuery})` : ''
  ].filter(Boolean).join(' OR ');

  const gqlQuery = `
    query {
      products(first: 50, query: "status:active${filters ? ' AND (' + filters + ')' : ''}") {
        edges {
          node {
            handle
            title
            tags
            priceRange {
              minVariantPrice { amount currencyCode }
            }
            description
            featuredImage { url altText }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch(SHOPIFY_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gqlQuery })
    });
    const data = await res.json();
    const products = data?.data?.products?.edges?.map(e => e.node) || [];

    // Sort so products whose title contains ALL meaningful keywords (e.g. both
    // "apple" AND "watch") appear first — this guarantees the model sees the
    // most relevant matches even if the 50-result cap would otherwise push
    // them out, and even though Shopify's own query only OR-matched individually.
    if (meaningfulKeywords.length > 1) {
      products.sort((a, b) => {
        const aTitle = (a.title || '').toLowerCase();
        const bTitle = (b.title || '').toLowerCase();
        const aMatchesAll = meaningfulKeywords.every(k => aTitle.includes(k)) ? 1 : 0;
        const bMatchesAll = meaningfulKeywords.every(k => bTitle.includes(k)) ? 1 : 0;
        return bMatchesAll - aMatchesAll;
      });
    }

    return products;
  } catch (err) {
    console.error('Product fetch failed:', err);
    return [];
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messages, profile } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const latestMessage = messages[messages.length - 1]?.content || '';
    const products = await fetchProductData(profile || {}, latestMessage);

    const productContext = `LIVE PRODUCT DATA (only use these, never invent products):\n${JSON.stringify(products, null, 2)}`;

    const currentProfile = profile && Object.keys(profile).length
      ? `CURRENT PROFILE STATE:\n${JSON.stringify(profile, null, 2)}`
      : 'CURRENT PROFILE STATE: (none yet, this is the first turn)';

    const anthropicMessages = [
      ...messages,
      {
        role: 'user',
        content: `[SYSTEM CONTEXT — not visible to customer]\n${currentProfile}\n\n${productContext}`
      }
    ];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages: anthropicMessages
      })
    });

    const data = await response.json();
    const rawText = data?.content?.[0]?.text || '';

    let parsed;
    try {
      const cleaned = rawText.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('Failed to parse Claude response:', rawText);
      return res.status(500).json({ error: 'Failed to parse AI response', raw: rawText });
    }

    // Hydrate recommended product handles into full product objects (with image) for the frontend
    if (parsed.recommended_products && Array.isArray(parsed.recommended_products)) {
      const hydrated = parsed.recommended_products
        .map(handle => products.find(p => p.handle === handle))
        .filter(Boolean)
        .map(p => ({
          handle: p.handle,
          title: p.title,
          price: p.priceRange?.minVariantPrice?.amount || null,
          currency: p.priceRange?.minVariantPrice?.currencyCode || null,
          image: p.featuredImage?.url || null,
          imageAlt: p.featuredImage?.altText || p.title
        }));
      parsed.recommended_products = hydrated;
    }

    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Matchmaker error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
