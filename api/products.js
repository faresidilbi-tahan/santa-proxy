const WORKER = 'https://delicate-smoke-ce37.abedtahanpromotions.workers.dev/';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { query = '', budget = 0 } = req.query;

  // Build Shopify search filter
  let queryFilter = 'status:active';
  if (query) queryFilter += ` AND (title:*${query}* OR tag:*${query}*)`;

  const gqlQuery = `
    query GetProducts($first: Int!, $query: String!) {
      products(first: $first, query: $query) {
        edges {
          node {
            id
            title
            handle
            vendor
            tags
            priceRangeV2 {
              minVariantPrice { amount currencyCode }
            }
            featuredMedia {
              preview { image { url } }
            }
            variants(first: 1) {
              edges { node { sku price } }
            }
          }
        }
      }
    }
  `;

  try {
    const upstream = await fetch(WORKER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: gqlQuery, variables: { first: 50, query: queryFilter } }),
    });

    const data = await upstream.json();
    if (data.errors) return res.status(400).json({ error: data.errors[0].message });

    const edges = data?.data?.products?.edges || [];
    let products = edges.map(({ node }) => {
      const price = parseFloat(node.priceRangeV2?.minVariantPrice?.amount || 0);
      return {
        id: node.id,
        sku: node.variants?.edges?.[0]?.node?.sku || '',
        name: node.title,
        price,
        price_str: `$${Math.round(price)}`,
        brand: node.vendor || '',
        tags: node.tags || [],
        img: node.featuredMedia?.preview?.image?.url || '',
        url: `https://www.abed-tahan.com/products/${node.handle}`,
      };
    });

    // Filter by budget with 20% tolerance
    const budgetNum = parseFloat(budget);
    if (budgetNum > 0) products = products.filter(p => p.price <= budgetNum * 1.2);

    return res.status(200).json({ products });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
