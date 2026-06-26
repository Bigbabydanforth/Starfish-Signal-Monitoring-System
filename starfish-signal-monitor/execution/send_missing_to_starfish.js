/**
 * send_missing_to_starfish.js
 *
 * Finds every Airtable record that is NOT yet in the Google Sheet,
 * then:
 *   → Google Sheets: appends ALL individual records (each contact gets its own row)
 *   → Email to Starfish: ONE card per company (no repeats), showing contact count for BSI
 *
 * Run (testing — sends to EMAIL_TO_TESTING):
 *   node execution/send_missing_to_starfish.js
 *
 * Run (production — sends to Starfish):
 *   NODE_ENV=production node execution/send_missing_to_starfish.js
 *
 * Dry run (no writes, no email — just shows what would happen):
 *   node execution/send_missing_to_starfish.js --dry-run
 */

import 'dotenv/config';
import { query } from './utils/airtable_client.js';
import { google, getAuth } from './utils/sheets_client.js';
import sendEmailWorkflow from './workflow_5_send_email.js';

// ── Companies already in Google Sheets (snapshot 2026-06-18) ─────────────────
const ALREADY_IN_SHEETS = [
  'Google', "Lowe's Companies, Inc.", 'ADP', 'Eli Lilly and Company', 'F&G',
  'LHH', 'Hewlett Packard Enterprise', 'Optum', 'Colgate-Palmolive', 'Exaforce',
  'Allegiant', 'Stratos', 'H.I.G. Capital', 'Dust', 'Nectar Social', 'Indicor',
  'Roadrunner', 'GridCare', 'USAA', 'Sidus Space', 'Radar', 'servicenow', 'VSXY',
  'Ferragamo', 'Nourish', 'Widmer Brothers', 'salesforce', 'The Doux', 'Aptum',
  'FLINT', 'Perseus Mining', 'Cielo', 'Verde AgriTech', 'Sylogist', 'MindBridge',
  'AMETEK', 'Greenland Mines', 'Authentic Brands Group', 'Molex', 'Artivion',
  'Siris', 'SRS Distribution', 'Motivity', 'RemotePass', 'Moment', 'Exa Labs',
  'BRAMI', 'IREN', 'Brami Protein Pasta', 'S&P Global Ratings Maalot',
  'United Site Services', 'Variational', 'LGI Homes', 'Hark', 'Convective Capital',
  'Wellness Pet Company', 'Synergis Software', 'Hermeus', 'ProphetX', 'FDH Aero',
  'Green Building Initiative', 'FleishmanHillard', 'Aleta', 'AmplifyMD', 'Boh',
  'Strength of Nature', 'greenvilleme', 'StrainX Bioworks', 'South Street Partners',
  'OpenRouter', 'Restaurant Technologies', 'LightTable', 'Experis', 'Sun Sentinel',
  'Emancipet', 'EHE Health', "Michter's", 'Owens & Minor', 'Airis Labs',
  'RevEng.AI', 'ixlayer', 'royal caribbean international', 'thrivent',
  'norwegian cruise line holdings ltd.', 'mars', 'cloudflare', 'old navy',
  'whirlpool corporation', 'mastercard', 'Trestle Studio LLC', 'CoStar Group Inc.',
  'Solstice', 'XCENA', 'Saris', 'Morgan & Morgan', 'Thea Energy', 'K92 Mining',
  'PHARMACISTS MUTUAL', 'Sprinklr', 'Burlington Stores, Inc.',
  'Dr. Matthew T. Provencher', 'Arixa Capital', 'Zenylitics', 'CREATE', 'Lanvin',
  'Ipsos', 'Gold Resource Corporation', 'Eurizon Capital SGR S.p.A',
  'Tourism Authority', 'DFNS', 'Annual Meeting Arrow Financial', 'Media That Connects',
  'AMCS Group', 'Scotch', 'Forage', 'PEAK ROCK CAPITAL AFFILIATE', 'PDW',
  'Focused Energy', 'CI Global Asset Management', 'Ona Therapeutics', 'Scispot',
  'Benchmark', 'FirstClub', 'Quobly', 'Ingenix', 'Town', 'Sekai', 'Terra AI',
  'Board', 'Tripo AI', 'Ex-Anduril engineer', 'Uncover',
  'American College of Lifestyle Medicine', 'Melanoma Research Alliance', 'Reejig',
  'Aprio', 'MobileHelp', 'Actabl', 'Jack Henry & Associates', 'Gluware',
  'Top 10 Franchises in Every Industry', 'CleanSpark', 'Flexential',
  'Origin Medical', 'Inc', 'Rhythm AI', 'Advent', 'Menopause Discussion Group',
  'Uniti Group', 'Cresset', 'Dusty Boots', 'Cabinetworks Group',
  // ── Added 2026-06-18 ──────────────────────────────────────────────────────
  'New York Legal Assistance Group', 'Producers Guild of America', 'Morgan Marine',
  'Vox Media', 'Granada Insurance Company', 'Corcoran Sunshine Marketing Group',
  'EyeQ Monitoring', 'Oldcastle', 'Novelis', 'Evotrex, Inc.',
  'Jefferies Conference Certara', 'Cullinan Metals', 'Med-Metrix', 'Arcline',
  'MSG electric', 'Kyle Field', 'Truist', 'Consolidated Water', 'CleanCore',
  'Sempra Infrastructure', 'Reco', 'Dualitas Therapeutics',
  'Kneat Enters into Definitive Agreement to be', 'Armadin', 'Kaiser Permanente',
  'American Specialty Toy Retailing Association', 'ICIMS', 'Clarivate', 'GrubMarket',
  'ODW Logistics', 'EDGE Markets', 'Sound Long-Term Care Management',
  'Frost & Sullivan', 'Niles Bolton Associates', 'Deb Meyer - Keller Williams Realty',
  'Movetic', 'FICO', 'lumen technologies', 'Tango Therapeutics, Inc',
  'the coca-cola company', 'US', 'hca healthcare', 'gilead sciences',
  'Brazos Residential', 'fidelity investments', 'ROYAL CARIBBEAN GROUP',
  'CMI Media Group', 'CFG Bank', 'Gitomer & Berenholz, PC',
  'Hunton Andrews Kurth LLP', 'Strictly Come Dancing', 'Rakuten Medical',
  'Fairfield County Catholic Cemeteries of the Diocese of Bridgeport', 'Clutch',
  "Keshav Reddy's Equal AI", 'United Capital', 'Second Nature Brands', 'Discovery',
  'Equal AI', 'Colliers', 'Equal', 'Deerfield Management', 'Artist Mauricio Ramirez',
  'Hubbell Incorporated', 'Helion, the Sam Altman-backed fusion startup',
  'PhoenixAI', 'TensorWave', 'Chptr', 'Neion Bio', 'Turnout', 'Endurance Energy',
  'Royal Philips partners with WellSpan Health, NewLimit', 'REMEDY', 'Coram AI',
  'Ingredion', 'Hut 8', 'NowVertical', 'Cyera', 'Greenland Energy Company',
  'Lophos', 'Manam Chocolate', 'Jedify', 'Ethereal Machines', 'Bunker Hill Mining',
  'Spiro', 'United Real Estate', 'Anguleris', 'HPX',
  'American Red Cross Of Kansas', 'American Cancer Society', 'Los Angeles Lakers',
  'Quantum', 'Paccar', 'Broadridge', 'Fcb Global', 'Octagon',
  'Nasa - National Aeronautics And Space Administration', 'Medtronic',
  'Wesco Aircraft', 'Ibm', 'Scholastic', 'One Call', 'Accenture',
  'Rainforest Alliance', 'Ccs Fundraising', 'Epam Systems', 'Ecmd, Inc.',
  'Frsteam, Inc.', 'Dallas College', 'Evonik', 'First Watch Restaurants',
  'Transcendia, Inc.', 'Repay - Realtime Electronic Payments', 'Ambit Energy',
  'Jefferies Group Inc', 'Goldman Sachs', 'Bloomberg News', 'Ihs Markit',
  'Newmark', 'Weedmaps', 'Mill Creek Management', 'Astrazeneca', 'Tenable',
  'Bozzuto\'s Inc', 'Versace', 'Sunset Healthcare Solutions', 'Synchrony',
  'Duval County Public Schools', 'Fpt Software Career', 'Ensemble Health Partners',
  'Atkore', 'Taylor Morrison', 'Wolters Kluwer', 'Vedder Price', 'Babson College',
  'Aon', 'Florida Virtual School', 'Skadden, Arps, Slate, Meagher & Flom Llp And Affiliates',
  'At&T', 'Sunpower Corporation', 'Alliance Healthcare Services', 'Ally', 'Csx',
  'Goodwin', 'Eci Software Solutions', 'Prescient', 'Royersford Spring Company',
  'Mai Capital Management', 'West Pharmaceutical Services', 'Anytime Fitness',
  'Je Dunn Construction', 'Oatey Company', 'Citadel Securities', 'Dataprise',
  'Major League Baseball (Mlb)', 'Hendricks Power Cooperative', 'Wells Fargo',
  'Mintel', 'Jw Marriott', 'Nelson Mullins Riley & Scarborough', 'Bark', 'Hirewell',
  'Foley & Lardner Llp', 'Angi', 'Payroc', 'Ges - Global Experience Specialists',
  'Sap', 'Ramp', 'Bluetriton Brands', 'Forbes', 'Walton Isaacson', 'Tommy Bahama',
  'The Trade Desk', 'Mainscape', 'Trinity Health', 'Compassus',
  'The National Institutes Of Health', 'Blue Ant Media', 'Penguin Random House',
  'Maritz', 'Wme | William Morris Endeavor', 'Tides', 'Iqvia',
  'Herschend Entertainment Company, Llc', 'National Hockey League (Nhl)',
  'Nbcuniversal', 'Mid American Energy Co.', 'Kanawha County Board Of Education',
  'Cognizant', 'Funko', 'Bjc Health System', 'Piper Sandler', 'Pepsico', 'Clear',
  'Novo Resources Corp', 'Regal Beloit Corporation', 'Merrill Lynch',
  'Boehringer Ingelheim', 'Cooley Llp', 'Ketchum', 'Emd Serono, Inc.',
  'Centene Corporation', 'Ensono', 'Tms International Llc', 'Southland Industries',
  'Schneider', 'Brunswick Billiards', 'We. Communications', 'Colas',
  'Ahrc New York City', 'Echo Global Logistics',
  'Paul, Weiss, Rifkind, Wharton & Garrison Llp', 'Ss&C Technologies',
  'Regions Bank', 'Sanmar', 'Acxiom Limited', 'Jpmorganchase', 'Carriage Services',
  'O.F. Mossberg & Sons, Inc.', 'Greenberg Traurig, Llp', 'News Corp', 'Vectra Ai',
  'Qualcomm', 'Latham & Watkins', 'Merck & Co., Inc.', 'Grey', 'Prudential Financial',
  'Epsilon', 'Shutts & Bowen Llp', 'Ksm (Katz, Sapper & Miller)', 'Jll',
  'Brookstone Construction', 'Upmc', 'Guidepost Solutions', 'Organon',
  'The Ups Store', 'Navitus Health Solutions', 'Molson Coors Beverage Company',
  'Hms', 'Kirkland\'s', 'Deloitte', 'The Wendy\'s Company', 'Xerox',
  'Sitterle Homes', 'Us Environmental Protection Agency (Epa)', 'The Baldwin Group',
  'Hilti Group', 'Caci International Inc', 'Alphasense', 'Metlife',
  'Rcf Economic & Financial Consulting, Inc.', 'Shipbob', 'Snp Group', 'Notion',
  'Nice', 'J.B. Hunt Transport Services, Inc.', 'Power & Tel',
  'Gardner White Furniture & Mattress', 'Unitedhealth Group', 'Hamilton Lane',
  'Bain & Company', 'Ef', 'Revature', 'Carfax', 'Uptime Institute', 'Cibc',
  'Palantir Technologies', 'Harbor Freight Tools', 'Grainger Colombia',
  'Tishman Speyer', 'Discover Financial Services', 'Gxo Logistics, Inc.',
  'Allstate', 'Kpmg', 'Arcadis', 'Zywave', 'United Guaranty Corporation',
  'Kiewit', 'Uc Irvine', 'Nudo', 'Montefiore Einstein Comprehensive Cancer Center',
  'Cohnreznick', 'Southern Company', 'Lafrance Corp', 'Hashicorp',
  'Peprotech, Now Part Of Thermo Fisher Scientific', 'Shelter Insurance Companies',
  'Ivy Tech Community College Indianapolis', 'A+E Global Media',
  'Lincoln Property Company', 'Vaxserve', 'Cbre|Hubbell Commercial',
  'Tri Pointe Homes', 'Info-Tech Research Group', 'David Yurman', 'William Blair',
  'Glg', 'Blue Cross Blue Shield Of Michigan', 'Gbh', 'Quality King Distributors',
  'Charmant Group', 'Exact Tool & Die Incorporated', 'Pwc', 'White & Case Llp',
  'Atwell, Llc', 'Jewelry Television', 'Greenhill Cogent', 'Nasdaq',
  'Virginia Tech', 'Pnc', '5wpr', 'Poetic Wanderlust', 'Icf',
  'Icon International, Inc.', 'Chevron Phillips Chemical Company',
  'Blue Book Construction Network', 'Grail', 'Oracle', 'Deloitte Digital',
  'Mullenlowe U.S.', 'Adobe', 'Nbc Sports', 'Eco De Los Andes S.A', 'Usmd',
  'Airshare', 'Bdo Usa', 'Asc Engineered Solutions', 'Hy-Vee, Inc.',
  'Schroeder Management Co', 'Shell', 'Dentsu', 'U.S. Legal Support', 'Robert Half',
  'Wealth Enhancement', 'Cordillera Investment Partners', 'Vtrips',
  'Twfg Insurance (The Woodlands Financial Group)', 'Samuels & Associates',
  'Hinshaw & Culbertson Llp', 'United Safety & Survivability Corporation', 'Hcvt',
  'Ey', 'Altice Usa', 'Musc Health', 'Great Expressions Dental Centers',
  'U.S. Bank', 'Ortho Clinical Diagnostics', 'Mclaren Health Care',
  'Aetna, A Cvs Health Company', 'Blackmagic Design', 'Splunk', 'Morgan Stanley',
  'Better Business Bureau Of Eastern Massachusetts, Maine, Rhode Island & Vermont',
  'Urban-Gro, Inc. (Nasdaq: Ugro)', 'Sirionlabs, Inc.', 'Nicklaus Children\'s Hospital',
  'Corporate Communication Solutions', 'Preferred Financial Group Inc.',
  'Morgan, Lewis & Bockius Llp', 'Axxiome', 'Viatris',
  'Graphic Packaging International, Llc', 'Wasserman', 'Universal Pictures',
  'Monumental Sports & Entertainment', 'Imperative Chemical Partners',
  'Bank Of America', 'Balfour Beatty Investments', 'John Hancock',
  'Acme United Corporation', 'Cemex', 'C4 Technical Services',
  'Capstone Logistics, Llc', 'T-Mobile', 'Milken Institute', 'Amwins',
  'Sony Music Entertainment', 'Ameriprise Financial Services, Llc',
  'Jefferson County Commission', 'Hickory Farms, Llc', 'Coupa Software',
  'Boyd Gaming', 'Quiddity', 'Travelers', 'U.S. Department Of Veterans Affairs',
  'Sei', 'Allegheny Health Network', 'Brightstar Care Of San Francisco',
  'Caleres, Inc.', 'Bmo Capital Markets', 'Sca Health', 'Kroll', 'Mongodb',
  'Philips', 'Ergon Inc.', 'Espn', 'Alvarez & Marsal', 'Wolfe Research, Llc',
  'Gentex Corporation', 'Group 1 Automotive', 'Baxter International Inc.',
  'Benchmark International', 'Amgen', 'Brandstar', 'Pittsburgh Public Schools',
  'Gannett Fleming', 'Datasite', 'Interstate All Battery Center - Sandusky',
  'Stanford Health Care', 'Akin Gump Strauss Hauer & Feld Llp', 'Banner Health',
  'Rocket Software', 'Bleacher Report', 'The Corcoran Group', 'Officemax',
  'Spin Master', 'Microsoft', 'Frost', 'Valuemomentum', 'Cynosure, Llc.',
  'Hntb', 'Farm Credit Services Of America', 'First Weber',
  'Alpine 4 Holdings, Inc.', 'Cigna Healthcare', 'Hanover Research', 'Hines',
  'Fish & Richardson P.C.', 'Cti Clinical Trial And Consulting Services',
  'Donatos Pizza', 'Los Angeles County Department Of Human Resources',
  'Shi International Corp.', 'United Talent Agency', 'Lincoln International',
  'Massachusetts Institute Of Technology', 'Freeman Companies', 'Invenergy',
  'Tbwa\\Chiat\\Day', 'U.S. Department Of Justice', 'Curtiss-Wright Corporation',
  'Ptc', 'Dinsmore & Shohl Llp', 'St. Croix Hospice', 'Netspend', 'Cgi',
  'Quorum Health', 'Smart Start, Inc.', 'Pike Corporation',
  'Lockton Dunning Benefits', 'Pye-Barker Fire & Safety', 'Niagara Bottling',
  'Rbc Capital Markets', 'Travere Therapeutics', 'The Jackson Laboratory',
  'Guidehouse', 'Perkins Coie', 'Oshi Health', 'L3harris Technologies',
  'Van Leeuwen Ice Cream', 'Association Of National Advertisers', 'Zynex Medical',
  'Art.Com', 'Mulesoft', 'Northern Trust Asset Servicing', 'Ieee',
  'Associated Packaging, Inc.', 'Inter Miami Cf', 'J.T.M. Food Group', 'Cbiz',
  'Booz Allen Hamilton', 'Association Of Fundraising Professionals (Afp Global)',
  'J.Hilburn', 'Paylocity', 'Frazier & Deeter', 'Zeta Global',
  'Enerpac Tool Group', 'Infinity Insurance', 'Mcgriff', 'Albertsons Companies',
  'Viome', 'Ups', 'Mohegan Sun', 'Modern Litho', 'Crown Castle', 'Uplight',
  'Lulu\'s', 'Bristol Farms', 'Kiva', 'Whole Foods Market', 'K&G Fashion Superstore',
  'Akerman Llp', 'Emergent Biosolutions', 'Griffith Foods', 'Ebsco Industries, Inc.',
  'Bright Horizons', 'Proampac', 'Northwestern Mutual - Philadelphia', 'Zevia',
  'Adm', 'Turning Stone Enterprises', 'Rent-A-Center', 'Blank Rome Llp',
  'Concentrix', 'Us Radiology Specialists', 'Imperial Clinical Research Services',
  'Moody\'s Corporation', 'Everfi', 'Truwest Credit Union', 'Btig',
  'Global Water Resources', 'Red Hat', 'Javelin Agency', 'Verizon', 'Pfizer',
  'Michigan Association Of Chiefs Of Police', 'Barnes & Thornburg Llp',
  'Remodel Health', 'Goodwill Industries International', 'Samsung Electronics',
  'Rutgers Cancer Institute Of New Jersey', 'Capital Investment Companies',
  'Apex Logistics International', 'Nine Energy Service', 'Pharmavite',
  'Sandals Resorts International', 'Industrial Rubber Products Co',
  'Western Window', 'The Business Journals', 'Phd', 'The Hartford',
  'Wellesley College', 'The Vertex Companies Llc', 'Fm', 'Impax Asset Management',
  'Slalom', 'Wellington Management', 'Mayo Clinic', 'Ahern', 'Smbc Group',
  'Icon Plc', 'The Aes Corporation', 'Madison Gas And Electric',
  'Texas Children\'s Hospital', 'Fis', 'J.Crew', 'Mount Carmel Health System',
  'Freese And Nichols', 'The Federal Savings Bank', 'Webflow', 'Redwood Trust, Inc.',
  'Touchmark', 'Cushman & Wakefield', 'Evernorth Health Services', 'Zoetis',
  'Gannett | Usa Today Network', 'Mgm', 'Gibson Dunn', 'Marsden Services',
  'Swisher', 'Eppendorf', 'Mcdonald\'s', 'Tata Chemicals', 'Carters Inc.',
  'Young\'s Market Company', 'Designer Brands', 'Pacific Castle', 'Escalent',
  'Northmarq', 'Ing', 'Turner (Turner Broadcasting System, Inc)', 'Bunting',
  'Ihg Hotels & Resorts', 'Brean Capital, Llc', 'Bj\'s Wholesale Club', 'Anomaly',
  'Hodgson Russ Llp', 'Federal Deposit Insurance Corporation (Fdic)',
  'Mercy Medical Center, Baltimore, Md', 'Ge Africa', 'Cpkc', 'Cambrex',
  'Morehouse College Center For Excellence In Education', 'Iprospect',
  'Fti Consulting', 'Chase', 'Galls', 'Roush', 'Delaware North', 'S&T Bank',
  'Ncino, Inc.', 'Televisaunivision', 'Amneal Pharmaceuticals', 'Alliancebernstein',
  'Scor', 'Morningstar', 'Pasona N A, Inc.', 'One Network Enterprises',
  'Centurion Health', 'Ebanx', 'The Briad Group',
  'Crystal Bridges Museum Of American Art', 'State Farm Agent', 'Rsm Us Llp',
  'Iheartmedia', 'Gpa Global | Packaging Solutions', 'Chromalloy', 'Nitel',
  'Dolphin', 'Fisher Phillips', 'Asurion', 'Ryan Specialty Underwriting Managers',
  'San Antonio Business Journal', 'Ima Financial Group, Inc.', 'Camp Gladiator',
  'Talogy', 'Grossman Yanak & Ford Llp', 'Norton Rose Fulbright',
  'Rhode Island School Of Design', 'New York City Department Of Probations',
  'Mettel', 'Authentic Custom Homes, Llc.', 'Nagarro', 'Bexar County', 'Spectrum',
  'Appcast, Inc', 'Avery Weigh-Tronix', 'Digital Turbine', 'Carecredit',
  'Bfg Agency', 'The Bernard Group, Inc.', 'U.S. Equities Realty',
  'Nissan Motor Corporation', 'International Paper', 'The Tjx Companies, Inc.',
  'Commcare Corporation', 'Baird', 'West Star Aviation Inc.',
  'Hackensack Meridian Health', 'Mellon Capital', 'Liberty Global', 'Abbott',
  'Csg', 'Lightstone', 'Cole, Scott & Kissane, P.A.', 'Syndax Pharmaceuticals',
  'Compass', 'American Airlines', 'Ibotta', 'Sally Beauty',
  'Union College Career Center In Becker Hall', 'Janney Montgomery Scott Llc',
  'Axa Investment Managers', 'Epson Latinoamérica', 'Meditech', 'Benesch',
  'Cre - Computer Rentals & Av Solutions', 'Butcherbox', 'Bbg Inc.',
  'Allied Beverage Group', 'Paystand', 'Havi', 'Evercore', 'Datwyler It Infra',
  'Align', 'Yahoo', 'Cfa Institute', 'Bankprov', 'Capital Title Of Texas, Llc',
  'Everquote', 'Kohl\'s Corporate', 'Princeton School Of Public And International Affairs',
  'Enpointe Technologies', 'Apache Industrial', 'American Family Insurance',
  'Yale New Haven Hospital', 'Saama', 'Deutsche Bank', 'Baker Donelson',
  'John R. Wood Properties', 'Douglas Elliman Real Estate', 'Technipfmc',
  'Moss Adams', 'Scannell Properties', 'Bank Of America Business', 'Osf Healthcare',
  'Canon Virginia, Inc', 'Digitas North America', 'Kaleyra', 'Lippe Taylor',
  'Proximo Spirits', 'Entrust', 'Biocatch', 'Woodstock Builders Ltd',
  'Bristol Myers Squibb', 'Amazon', 'Debevoise & Plimpton',
  'Sdi International Corp.', 'Sammons Financial Group Companies', 'Takeda',
  'Apartments.Com', 'Ubs', 'Informa Techtarget', 'Sageview Advisory Group',
  'Nearmap', 'Westgate Resorts', 'Drivesavers Data Recovery',
  'Associated Materials Innovations', 'William Osler Health System', 'Visier Inc.',
  'Capital One', 'Peak6', 'American Credit Acceptance', 'Cme Group', 'Volt',
  'Carolina Software As A Service, Inc.', 'Altisource', 'Alphabroder',
  'West Monroe', 'Aarp', 'Learfield', 'Prime Insurance Company', 'Verathon',
  'Rc Willey', 'Marriott International', 'Omnicom Health',
  'Peerless Network, An Infobip Company', 'Vireo Health Inc.', 'Chevron',
  'Rapportww', 'Nike', 'Dayco', 'Ssi Schäfer', 'Fti - Frontier Technology Inc.',
  'Uhs', 'Venable Llp', 'Railworks Corporation', 'Park Place Technologies',
  'Maverik, Inc.', 'Barings', 'Kutak Rock', 'Lpl Financial', 'Equifax',
  'Laticrete International', 'Gi Partners', 'Tiaa', 'Harpercollins Publishers',
  'Dynamic Systems, Inc.', 'Credit Acceptance', 'Sellers Dorsey',
  'The Whiting-Turner Contracting Company', 'Vaco', 'Agi', 'Johnny Was',
  'Avalonbay Communities, Inc.', 'Savers | Value Village', 'Lifetime Products',
  'Lowe', 'Ykk', 'Sanofi', 'Sutherland', 'Verst Logistics', 'Sodexo',
  'The Money Source Inc.', 'Webster Bank', 'Mercer', 'Annalect India',
  'Team Lewis', 'B&H Photo Video', 'Nationsbenefits', 'Seyfarth Shaw Llp',
  'Memorial Sloan Kettering Cancer Center', 'United Federal Credit Union',
  'Edc.Org', 'Reed Exhibitions Hong Kong', 'Geiger', 'Bp', 'Grinnell College',
  'Transworld Service', 'Dream Town Real Estate',
  'Air Force Office Of Scientific Research (Afosr)', 'Apellis Pharmaceuticals',
  'Artesian Water Company', 'Edwards Lifesciences', 'Ge Healthcare',
  'Midcap Financial', 'Columbia Investments', 'Pctel', 'Cti',
  'Tata Consultancy Services', 'Southwest Funding', 'Mode Transportation',
  'Gehl Food & Beverage', 'Covestro', 'First Financial Bank', 'March Of Dimes',
  'Matrix Absence Management', 'Revlon', 'Sokal', 'Abc', 'Jobs At Uhs',
  'Intelex Technologies Ulc', 'Humanscale', 'Keybank', 'Firstbank',
  'Google Via Magnit (Formerly Pro Unlimited)', 'Cordium (Now Part Of Aca Compliance Group)',
  'Suntrup Automotive Group', 'Apollo Global Management, Inc.', 'Northrop Grumman',
  'Aramark', 'Kone', 'Amerisourcebergen', 'Popular', 'Brown And Caldwell',
  'Crc Group', 'Vision Critical', 'Lam Research', 'Trc Companies, Inc.',
  'Sheppard Mullin Richter & Hampton Llp', 'Americhem Inc.', 'Clover',
  'Federal Reserve Bank Of San Francisco', 'Bgb Group', 'Nothing Bundt Cakes',
  'Sinclair Inc.', 'Mclane Company, Inc.', 'Sun Pharma', 'Eab',
  'Eagle Mountain-Saginaw Isd', 'G-Iii Apparel Group', 'Isaca', 'Phenom',
  'Mymichigan Health', 'Benjamin Moore', 'Td', 'Heineken Ecuador',
  'Beacon Specialized Living', 'Republic Services', 'Software Ag', 'Epicor',
  'Airtable', 'Mcgill And Partners', 'Unilever',
  'Chick-Fil-A Corporate Support Center', 'Lincare', 'Lighthouse',
  'Emory Healthcare', 'Trinity Life Sciences', 'Precision 2000 (P2k)',
  'Amalgamated Bank', 'Christianacare', 'Extended Stay America', 'Newsela, Inc.',
  'The Venetian Resort Las Vegas', 'Conservice', 'Alliantgroup', 'Plug Power',
  'Polaris Inc.', 'Rho', 'Yess | Ymca Enterprise Shared Services',
  'Mcdermott Will & Emery', 'Humana', 'Fields And Dennis Llp',
  'Cypress-Fairbanks Isd', 'Houston Methodist', 'Cort', 'H-E-B', 'Biohavenpharma',
  'Niru Group', 'National Field Representatives', 'Schott Nyc', 'Fresh Express',
  'Oppenheimer & Co. Inc.',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalize(name) {
  if (!name) return '';
  return name.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

const ALREADY_NORMALIZED = new Set(ALREADY_IN_SHEETS.map(normalize));

const PRIORITY_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };

// ── Convert Airtable record → Google Sheet row ────────────────────────────────
function recordToRow(record) {
  const f = record.fields;
  const rawRevenue = Number(f['Company Revenue']);
  const revenue = f['Company Revenue'] && !isNaN(rawRevenue)
    ? `$${rawRevenue.toLocaleString()}`
    : '';
  return [
    f['Company Name']          || '',
    f['Signal Details']        || '',
    f['Signal Type']           || '',
    f['Contact Info']          || '',
    revenue,
    f['Company Funding Stage'] || '',
    f['Industry']              || '',
    f['Date Detected']         || '',
    f['Priority']              || '',
    f['Brief']                 || '',
    f['Contact Approach']      || '',
    f['Source URL']            || '',
    f['Status']                || 'New',
    f['Created At']            || '',
    f['Last Modified']         || ''
  ];
}

// ── Group records by company → one signal per company for email ───────────────
// BSI companies can have 5 rows in Airtable (one per contact/send day).
// For the email we collapse them into ONE card showing the contact count.
// Non-BSI companies are already one row each — they just get deduplicated.
function buildEmailSignals(records) {
  // Group by normalized company name
  const groups = new Map();
  for (const r of records) {
    const name = r.fields['Company Name'] || '';
    const key  = normalize(name) || name;
    if (!groups.has(key)) groups.set(key, { displayName: name, records: [] });
    groups.get(key).records.push(r);
  }

  const signals = [];

  for (const { displayName, records: group } of groups.values()) {
    // Pick the record with the highest priority as the "base" for the card
    const base = group.reduce((best, r) => {
      const rp = PRIORITY_RANK[r.fields['Priority']] || 0;
      const bp = PRIORITY_RANK[best.fields['Priority']] || 0;
      return rp > bp ? r : best;
    });

    const type         = base.fields['Signal Type'] || 'News/Press';
    const contactCount = group.length;

    // For BSI: summarise contact count instead of repeating per-contact rows.
    // Starfish can open Airtable to see the full contact list.
    let contactInfo;
    if (type === 'Brand Strategy Intent') {
      contactInfo = contactCount === 1
        ? '1 contact identified — open Airtable for full details'
        : `${contactCount} contacts identified — open Airtable for full details`;
    } else {
      contactInfo = base.fields['Contact Info'] || '';
    }

    signals.push({
      company:            { name: displayName, industry: base.fields['Industry'] || '' },
      type,
      priority:           base.fields['Priority'] || 'MEDIUM',
      brief:              base.fields['Brief']    || '',
      source_url:         base.fields['Source URL'] || '#',
      person:             null,
      contact_info_raw:   contactInfo,
      signal_details_raw: base.fields['Signal Details'] || ''
    });
  }

  // Sort: HIGH first, then MEDIUM, then LOW
  return signals.sort((a, b) =>
    (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0)
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
const isDryRun = process.argv.includes('--dry-run');

(async () => {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║     Send Missing Signals → Sheets + Starfish Email   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if (isDryRun) console.log('⚠️  DRY RUN — no writes, no email\n');

  // ── Step 1: Fetch all Airtable records ──────────────────────────────────────
  console.log('[Step 1] Fetching all records from Airtable...');
  let allRecords;
  try {
    allRecords = await query({
      sort: [
        { field: 'Date Detected', direction: 'asc' },
        { field: 'Created At',    direction: 'asc' }
      ]
    }, 120000);
  } catch (err) {
    console.error('[Step 1] ❌ Airtable query failed:', err.message);
    process.exit(1);
  }
  console.log(`[Step 1] ✅ ${allRecords.length} total records in Airtable`);

  // ── Step 2: Filter out what's already in Sheets ──────────────────────────────
  const missingRecords = allRecords.filter(r =>
    !ALREADY_NORMALIZED.has(normalize(r.fields['Company Name'] || ''))
  );

  const emailSignals    = buildEmailSignals(missingRecords);
  const uniqueCompanies = emailSignals.length;

  console.log(`\n[Step 2] Already in Sheets : ${allRecords.length - missingRecords.length} records`);
  console.log(`[Step 2] Missing from Sheets: ${missingRecords.length} records (${uniqueCompanies} unique companies)`);

  if (missingRecords.length === 0) {
    console.log('\n✅ Sheet is already up to date — nothing to add or send.\n');
    process.exit(0);
  }

  // ── Preview ──────────────────────────────────────────────────────────────────
  console.log('\n[Preview] What will be EMAILED to Starfish (1 card per company):');
  emailSignals.forEach((s, i) => {
    const count = missingRecords.filter(
      r => normalize(r.fields['Company Name'] || '') === normalize(s.company.name)
    ).length;
    const suffix = count > 1 ? ` (${count} contacts)` : '';
    console.log(`  ${String(i + 1).padStart(3)}. [${s.priority}] ${s.company.name} — ${s.type}${suffix}`);
  });

  console.log(`\n  → ${missingRecords.length} rows will be written to Google Sheets`);
  console.log(`  → ${uniqueCompanies} company cards will appear in the email`);

  if (isDryRun) {
    console.log('\n[Dry Run] Done — no changes made.\n');
    process.exit(0);
  }

  // ── Step 3: Append ALL missing rows to Google Sheets ─────────────────────────
  // Only runs in test/development — production skips this to avoid double-writing.
  // Workflow: run test first (writes Sheets + sends to you), then run production
  // (email only → Starfish). Sheets is already up to date after the test run.
  const env = process.env.NODE_ENV || 'development';

  if (env === 'production') {
    console.log('\n[Step 3] Skipping Sheets write in production (already written during test run)');
  } else {
    console.log(`\n[Step 3] Appending ${missingRecords.length} rows to Google Sheets...`);
    try {
      const auth    = getAuth();
      const sheets  = google.sheets({ version: 'v4', auth });
      const sheetId = process.env.GOOGLE_SHEET_ID;
      const rows    = missingRecords.map(recordToRow);

      // Find the true last data row in column A (starting from row 5)
      const colARes = await sheets.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range:         'Signals!A5:A'
      });
      const existingRows = colARes.data.values || [];
      const nextRow = 5 + existingRows.length;

      console.log(`[Step 3] Last data row is ${nextRow - 1}, writing from row ${nextRow}`);

      await sheets.spreadsheets.values.update({
        spreadsheetId:    sheetId,
        range:            `Signals!A${nextRow}`,
        valueInputOption: 'USER_ENTERED',
        requestBody:      { values: rows }
      });

      console.log(`[Step 3] ✅ ${rows.length} rows written starting at row ${nextRow}`);
    } catch (err) {
      console.error('[Step 3] ❌ Google Sheets write failed:', err.message);
      console.error('         Continuing to email step anyway...');
    }
  }

  // ── Step 4: Send deduplicated email to Starfish ───────────────────────────────
  const recipient = env === 'production'
    ? (process.env.EMAIL_TO_PRODUCTION || 'EMAIL_TO_PRODUCTION not set')
    : (process.env.EMAIL_TO_TESTING    || 'EMAIL_TO_TESTING not set');

  console.log(`\n[Step 4] Sending email (${env}) → ${recipient}`);
  console.log(`         ${uniqueCompanies} unique company cards in this email`);

  try {
    const success = await sendEmailWorkflow(emailSignals);
    if (success) {
      console.log('[Step 4] ✅ Email sent successfully');
    } else {
      console.error('[Step 4] ❌ Email failed — check logs/.tmp for details');
    }
  } catch (err) {
    console.error('[Step 4] ❌ Email threw:', err.message);
  }

  console.log('\n✅ All done.\n');
})();
