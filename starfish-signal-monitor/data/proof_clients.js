// data/proof_clients.js
// Source: Starfish Co. client list v4 — 66 categories, 200+ clients

const PROOF_CLIENTS = {
  // Marketing & Agency Services
  'advertising agencies': 'EURO RSCG / Black Rocket, Martin Agency, Nitro New York, Omnicom Media, Young & Rubicam Brands',
  'advertising services': 'EURO RSCG / Black Rocket, Martin Agency, Nitro New York, Omnicom Media, Young & Rubicam Brands',
  'pr & communications': 'Cone Communications, Porter Novelli, Select Communications, Vertis Communications',
  'public relations': 'Cone Communications, Porter Novelli, Select Communications, Vertis Communications',
  'research & marketing services': 'Banjo Strategic Entertainment, Benson Strategy Group, EarthQuake Media, Penn Schoen Berland',
  'market research': 'Banjo Strategic Entertainment, Benson Strategy Group, Penn Schoen Berland',

  // Fashion & Consumer
  'apparel & fashion': 'Bonobos, Orolay, Phat Fashions, SOLD Jeans',
  'apparel manufacturing': 'Bonobos, Orolay, Phat Fashions, SOLD Jeans',
  'beauty & personal care': 'Avacor, CCA Industries, Revlon, Swish',
  'cosmetics': 'Avacor, CCA Industries, Revlon, Swish',
  'furniture & home furnishings': 'ASKA, Cort Furniture Rental, Innovant, Talalay Global',
  'health & wellness products': 'NutraBoost, Weight Watchers',
  'health, wellness & fitness': 'NutraBoost, Weight Watchers',
  'jewelry & luxury': 'Astra Diamond Manufacturers, De Beers Diamonds',
  'retail luxury goods': 'Astra Diamond Manufacturers, De Beers Diamonds',
  'retail & e-commerce': 'Chewy, Double Take, Gallerist.com',
  'retail': 'Chewy, Double Take, Gallerist.com',
  'internet & e-commerce': 'Amazon, HotJobs.com',
  'internet': 'Amazon, HotJobs.com',
  'sporting goods & leisure': 'Bullfrog Spas, Burton Snowboards, IZZO',

  // Education
  'for-profit education & edtech': 'Adtalem Global Education, Encoura',
  'higher education': 'American Public University System, Rochester Institute of Technology (RIT), UL Research Institutes',
  'higher education & research': 'American Public University System, Rochester Institute of Technology (RIT), UL Research Institutes',
  'k-12 & assessment': 'ERB (Educational Records Bureau), PAVE Charter School',
  'primary and secondary education': 'ERB (Educational Records Bureau), PAVE Charter School',
  'education administration programs': 'American Public University System, Adtalem Global Education, ERB (Educational Records Bureau)',

  // Technology
  'consumer electronics & computing': 'Casio, Hewlett-Packard, Panasonic, Samsung, Sharp Electronics, Sony',
  'consumer electronics': 'Casio, Hewlett-Packard, Panasonic, Samsung, Sharp Electronics, Sony',
  'home & kitchen appliances': 'Fotile America, Haier America, Hisense USA, Midea, SodaStream USA',
  'software & saas': 'Airfy, BrightSign, Majesco, Volchar',
  'it & technical services': 'Cognizant Technology Solutions, Connell Associates, Corsis, TEKsystems',
  'information technology & services': 'Cognizant Technology Solutions, Connell Associates, TEKsystems, BrightSign, Majesco',
  'telecommunications': 'Arris, AT&T Wireless, Rush Mobile, Vodafone, Vonage',
  'adtech & digital advertising': 'adMarketplace, CatapultX, Datran Media, Dstillery, Integral Ad Science, Madison Logic, Nexxen (Tremor), PebblePost',
  'data, analytics & ai': 'AccuWeather, Ayasdi, Cognitive Scale, People Data Solutions',
  'data analytics': 'AccuWeather, Ayasdi, Cognitive Scale, People Data Solutions',

  // Energy & Infrastructure
  'energy, utilities & infrastructure': 'ABB, EnBW, JBC Industries, Square One Energy',
  'utilities': 'ABB, EnBW, JBC Industries',
  'oil and gas': 'ABB, EnBW, Square One Energy',

  // Financial Services
  'asset & investment management': 'Barings, Barron Capital, Cornerstone Capital Group, EP Wealth Advisors, Principal Financial Group, Sagehall Partners',
  'financial services': 'Barings, EP Wealth Advisors, Principal Financial Group, CIT Group, Freedom Mortgage, StoneX',
  'banking': 'Circle Lending, CIT Group, Freedom Mortgage, Sun Coast Bank, UTC Trust Corporation',
  'banking, lending & trust': 'Circle Lending, CIT Group, Freedom Mortgage, Sun Coast Bank',
  'capital markets & exchanges': 'American Stock Exchange, American Stock Transfer & Trust, StoneX',
  'fintech & financial data': 'CRISIL, FS Vector, Innovest Systems',
  'accounting & financial advisory': 'BDO, PwC, WithumSmith+Brown',
  'management & strategy consulting': 'Gallup, L.E.K. Consulting, Navigant / Guidehouse',
  'business consulting and services': 'Gallup, L.E.K. Consulting, Navigant / Guidehouse',

  // Food & Beverage
  'packaged food, beverage & grocery': 'Chiquita Brands, GoGo squeeZ, Mentos, Natural Grocers, Pepsi-Cola North America',
  'food and beverage services': 'Chiquita Brands, GoGo squeeZ, Mentos, Pepsi-Cola North America',
  'restaurants & dining': "Bonefish Grill, Carrabba's, Darden, Dunkin', Fleming's, Outback Steakhouse, Panera Bread",
  'restaurants': "Bonefish Grill, Carrabba's Italian Grill, Darden, Dunkin', Outback Steakhouse, Panera Bread",
  'vodka, tequila & white spirits': 'Khortytsa Vodka, Leaf Vodka, Olmeca Tequila',
  'whiskey & brown spirits': 'Bushmills Irish Cream, Carpathian Whiskey, Wild Turkey',
  'wine & diversified alcohol': 'Alexandrion Group, Bayadera Group, Global Spirits, Pernod Ricard',

  // Healthcare
  'digital health & telehealth': 'ClearMD, Health Rush, UpScript',
  'hospitals & health systems': "AtlantiCare, Brooklyn Hospital Center, Kaiser Permanente, Texas Children's Hospital",
  'hospitals and health care': "AtlantiCare, Brooklyn Hospital Center, Kaiser Permanente, Texas Children's Hospital",
  'medical groups & provider services': 'Apollo Care, Enhanced Care Initiatives, Optum Care Network, Tandigm Health',
  'senior living & aging services': 'Benedictine Living, RiverSpring Health, Silver Solutions',
  'medical device': 'Baxter International, Entellus Medical, Hologic, Hu-Friedy',
  'medical devices & equipment': 'Baxter International, Entellus Medical, Hologic, Hu-Friedy',
  'pharmaceuticals': 'Boehringer Ingelheim, Johnson & Johnson, TherapeuticsMD, Cosette Pharmaceuticals',
  'pharmaceutical manufacturing': 'Boehringer Ingelheim, Johnson & Johnson, TherapeuticsMD',
  'biotech': 'Amyris Biotechnologies, Iveric Bio',
  'biotechnology': 'Amyris Biotechnologies, Iveric Bio',
  'diagnostics & life-science data': 'Centerphase Solutions, Oxford Immunotec, Velsera (Seven Bridges)',

  // Insurance
  'insurance services & insuretech': 'Asurion, ClaimDOC, Halpern, Storm Risk Solutions',
  'insurance': 'Asurion, Combined Insurance, Guardian Life Insurance, Nationwide Insurance',
  'life, health & benefits insurance': 'Combined Insurance, Guardian Life Insurance, Lincoln Financial Services, Trustmark',
  'p&c & specialty insurance': 'American Guardian Warranty Services, Nationwide Insurance, Western World Insurance Group',

  // Legal
  'large / national law firms': 'Adams & Reese, Debevoise & Plimpton, Holland & Knight, Lowenstein Sandler, McGuireWoods, Ropes & Gray, Willkie Farr & Gallagher, Winston & Strawn',
  'law practice': 'Adams & Reese, Debevoise & Plimpton, Holland & Knight, Lowenstein Sandler, McGuireWoods, Ropes & Gray',
  'legal services': 'Adams & Reese, Debevoise & Plimpton, Holland & Knight, Lowenstein Sandler',
  'boutique & regional law firms': 'Hicks Johnson, OlenderFeldman',

  // Media & Entertainment
  'digital & broadcast media': 'Hearts & Science, Mail Online, Sherwood Trading Group',
  'entertainment providers': 'NFL, Primary Wave, Yash Raj Films',
  'entertainment, music & sports': 'NFL, Primary Wave, Yash Raj Films (YRF)',
  'publishing & magazines': "Advance Magazine Group, Condé Nast, Elle Magazine, House & Garden Magazine, Reader's Digest",
  'media and telecommunications': 'Advance Magazine Group, Condé Nast, Hearts & Science, Mail Online',

  // Real Estate
  'commercial properties & buildings': '10 Bryant (452 Fifth Ave), Empire State Building, Seagram Building, 100 Wall Street',
  'reits, owners & re services': 'Associated Estates Realty Corp, JLL, Leyton Properties, Vornado Realty Trust',
  'real estate': 'Associated Estates Realty Corp, JLL, Leyton Properties, Vornado Realty Trust',
  'real estate agents and brokers': 'JLL, Associated Estates Realty Corp',

  // Staffing & HR
  'staffing, bpo & hr services': 'Firstsource, MarketSource, PEOps, RightClick Professional Services',
  'staffing and recruiting': 'Firstsource, MarketSource, PEOps, RightClick Professional Services',
  'executive search services': 'Firstsource, MarketSource, RightClick Professional Services',

  // Hospitality & Travel
  'hospitality, travel & leisure': '24 Hour Fitness, Choice Hotels International, Sodexo, Visit Greater Palm Springs',
  'hospitality': '24 Hour Fitness, Choice Hotels International, Sodexo',
  'leisure, travel and tourism': 'Choice Hotels International, Sodexo, Visit Greater Palm Springs',

  // Transportation
  'aviation & aerospace': 'Atlas Air, Avidyne',
  'ground transportation & automotive': 'Avis Budget Group, EmpireCLS, Holman Enterprises, Montway Auto Transport',
  'automotive': 'Avis Budget Group, EmpireCLS, Holman Enterprises',
  'logistics & shipping': 'Purolator International, Source Logistics',
  'logistics and supply chain': 'Purolator International, Source Logistics',

  // Nonprofits & Government
  'advocacy, civil rights & labor': 'American Jewish Committee, Anti-Defamation League (ADL), SEIU 32BJ',
  'arts & education nonprofits': 'Education Through Music, New York Theatre Workshop',
  'government agencies': 'NYC Department of Environmental Protection, NYC Department of Health & Mental Hygiene',
  'social & community services': 'Community FoodBank of New Jersey, FPWA, Jersey Cares, Worldwide Shelters',
  'senior services nonprofit': 'Carter Burden Center for the Aging, LiveOn NY',

  // Building & Construction
  'building materials & furnishings': 'Comfortex Window Coverings, Garden State Tile, Prime-Line',
  'building construction': 'Comfortex Window Coverings, Garden State Tile, Prime-Line',
  'lighting & electrical services': 'Integrated Electrical Service, SATCO',
  'plumbing & fixtures': 'Grohe America, Jaclo Industries, Repipe Specialists',

  // Default fallback
  'default': 'Pepsi-Cola North America, Johnson & Johnson, NFL, Cognizant Technology Solutions, JLL'
};

function getProofClients(industry) {
  if (!industry) return PROOF_CLIENTS['default'];

  const key = industry.toLowerCase().trim();

  // Exact match
  if (PROOF_CLIENTS[key]) return PROOF_CLIENTS[key];

  // Partial match — check if any key is contained in the industry string
  for (const [k, v] of Object.entries(PROOF_CLIENTS)) {
    if (k === 'default') continue;
    if (key.includes(k) || k.includes(key)) return v;
  }

  // Word-by-word match — find best partial
  const industryWords = key.split(/\s+/);
  for (const [k, v] of Object.entries(PROOF_CLIENTS)) {
    if (k === 'default') continue;
    const keyWords = k.split(/\s+/);
    const overlap = industryWords.filter(w =>
      keyWords.some(kw => kw.includes(w) || w.includes(kw))
    );
    if (overlap.length >= 2) return v;
  }

  return PROOF_CLIENTS['default'];
}

export { getProofClients, PROOF_CLIENTS };
