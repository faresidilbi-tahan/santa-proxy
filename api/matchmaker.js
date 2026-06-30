// api/matchmaker.js

const SYSTEM_PROMPT = `You are Matchmaker, an AI shopping advisor for Abed Tahan, a Lebanese electronics and home appliances retailer with 9 showrooms across Lebanon. You are not a chatbot — you are a knowledgeable, warm advisor helping someone find the right gift. You speak in the customer's language (Arabic or English), matching their tone naturally.

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

RECOMMENDATION RULES
1. Recommend 1-3 products max. Never overwhelm with a long list.
2. Every recommendation must include a short, specific reason tied to the recipient's profile — not a generic product description.
3. Suggest a complementary product or bundle only when it genuinely adds value.
4. If a product is requested but out of stock or doesn't exist, say so plainly and offer the closest real alternative. Never invent products or specs.
5. After recommending, keep helping: offer to compare options, suggest a different price tier, or adjust based on feedback.

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

Always return the full updated profile object, carrying forward everything from the previous turn and only updating fields with new information. Never null out a field that was already filled unless the customer explicitly corrects it.

DATA INTEGRITY
Only reference products and specs from the live product data provided to you. Never hallucinate a product, price, or spec. If you don't have enough product data to answer something, say so honestly rather than guessing.`;

const SHOPIFY_WORKER_URL = 'https://delicate-smoke-ce37.abedtahanpromotions.workers.dev/';

async function fetchProductData(profile) {
  // Build a simple tag/category query based on whatever the profile knows so far.
  // Adjust the GraphQL query/tags to match your actual store taxonomy.
  const interests = profile?.recipient?.interests?.join(' OR tag:') || '';
  const gqlQuery = `
    query {
      products(first: 20, query: "status:active${interests ? ' AND (tag:' + interests + ')' : ''}") {
        edges {
          node {
            handle
            title
            tags
            priceRange { minVariantPrice { amount } }
            description
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
    return data?.data?.products?.edges?.map(e => e.node) || [];
  } catch (err) {
    console.error('Product fetch failed:', err);
    return [];
  }
}

export default async function handler(req, res) {
  // CORS
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
    // messages: array of { role: 'user' | 'assistant', content: string }
    // profile: the hidden profile JSON object from the previous turn (or empty on first turn)

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array is required' });
    }

    const products = await fetchProductData(profile || {});

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

    return res.status(200).json(parsed);

  } catch (err) {
    console.error('Matchmaker error:', err);
    return res.status(500).json({
