const WORKER = 'https://delicate-smoke-ce37.abedtahanpromotions.workers.dev/';

const KEYWORD_TAG_MAP = {
  fitness:      'Personal Care & Fitness',
  gym:          'Sports Equipment',
  treadmill:    'Treadmill',
  exercise:     'Sports Equipment',
  workout:      'Sports Equipment',
  sport:        'Sports Equipment',
  bike:         'Exercise Bike',
  elliptical:   'Elliptical',
  yoga:         'Yoga',
  pilates:      'Yoga',
  tv:           'Televisions',
  television:   'Televisions',
  laptop:       'Laptops',
  computer:     'Laptops',
  phone:        'Smartphones',
  smartphone:   'Smartphones',
  iphone:       'iPhone',
  tablet:       'Tablets',
  ipad:         'iPad',
  audio:        'Audio',
  speaker:      'Speakers',
  headphone:    'Headphones',
  headset:      'Headphones',
  camera:       'Cameras',
  watch:        'Smart Watch',
  coffee:       'Coffee Machines',
  kitchen:      'Small Kitchen Appliances',
  cooking:      'Small Kitchen Appliances',
  blender:      'Blenders',
  fridge:       'Refrigerators',
  refrigerator: 'Refrigerators',
  freezer:      'Freezers',
  washer:       'Washing Machines',
  washing:      'Washing Machines',
  vacuum:       'Vacuum Cleaners',
  gaming:       'Gaming',
  console:      'Gaming',
  playstation:  'Gaming',
  beauty:       'Beauty',
  hair:         'Hair Care',
  massage:      'Massage',
  printer:      'Printers',
  router:       'Routers',
  microwave:    'Microwaves',
  oven:         'Ovens',
  dishwasher:   'Dishwashers',
  outdoor:      'Outdoor',
  grill:        'Grills',
  aircon:       'Air Conditioners',
};

function extractTag(query) {
  const q = query.toLowerCase();
  for (const [kw, tag] of Object.entries(KEYWORD_TAG_MAP)) {
    if (q.includes(kw)) return tag;
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { query = '', budget = 0 } = req.query;

  const tag = extractTag(query);
  let queryFilter = 'status:active';
  if (tag) {
    queryFilter += ` AND tag:"${tag}"`;
  } else if (query) {
    queryFilter += ` AND title:*${query}*`;
  }

  const gqlQuery = `
    query GetProducts($first: Int!, $query: String!) {
      products(first: $first, query: $query) {
        edges {
          node {
            id title handle vendor status tags
            priceRangeV2 { minVariantPrice { amount currencyCode } }
            featuredMedia { preview { image { url } } }
            variants(first: 1) { edges { node { sku price } } }
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

    const budgetNum = parseFloat(budget);
    if (budgetNum > 0) products = products.filter(p => p.price <= budgetNum * 1.2);

    return res.status(200).json({ products });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
