import 'dotenv/config';
import axios from 'axios';

const MARKETING_TITLES = [
  "chief marketing officer",
  "cmo",
  "chief brand officer",
  "chief communications officer",
  "vp marketing",
  "vp of marketing",
  "vice president marketing",
  "vice president of marketing",
  "svp marketing",
  "evp marketing",
  "head of marketing",
  "head of brand",
  "head of communications",
  "director of marketing",
  "director of brand",
  "marketing director",
  "brand director"
];

const CSUITE_FALLBACK = [
  "chief executive officer",
  "ceo",
  "president",
  "chief operating officer",
  "coo"
];

async function findMarketingContactAtCompany(companyDomain) {
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey) {
    console.error("APOLLO_API_KEY is not set in .env!");
    return null;
  }

  const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';

  // PASS 1 — Search for marketing titles specifically
  console.log(`[Apollo] Searching for marketing contacts at ${companyDomain}...`);
  try {
    const searchResponse = await axios.post(
      `${baseUrl}/mixed_people/api_search`,
      {
        person_titles: MARKETING_TITLES,
        person_seniorities: ['c_suite', 'vp', 'director'],
        q_organization_domains: companyDomain, // Using codebase-standard q_organization_domains
        person_locations: ['United States'],
        per_page: 10,
        page: 1
      },
      {
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const people = searchResponse.data?.people || [];
    console.log(`Apollo search: ${people.length} marketing contacts found at ${companyDomain}`);

    // Print out search results info
    for (const p of people) {
      console.log(` - ID: ${p.id} | Name: ${p.first_name} ${p.last_name || '[hidden]'} | Title: ${p.title} | Has Email: ${p.has_email}`);
    }

    // Filter to only people Apollo has an email for
    const enrichable = people.filter(p => p.has_email === true);

    if (enrichable.length === 0) {
      console.log(`No enrichable marketing contacts found at ${companyDomain}. Trying C-Suite fallback...`);
      return await findCSuiteAtCompany(companyDomain);
    }

    // Enrich the first match
    const target = enrichable[0];
    console.log(`Enriching target marketing contact: ${target.first_name} (ID: ${target.id})...`);
    
    // We try the POST /people/match endpoint to trigger the unlock/reveal action
    const enrichResponse = await axios.post(
      `${baseUrl}/people/match`,
      {
        id: target.id,
        reveal_personal_emails: false
      },
      {
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const person = enrichResponse.data?.person;
    if (!person) {
      console.log("Enrichment returned empty result.");
      return null;
    }

    console.log("Enrichment successful!");
    return {
      first_name: person.first_name,
      last_name: person.last_name,
      email: person.email,
      email_status: person.email_status,
      title: person.title,
      linkedin_url: person.linkedin_url,
      source: 'Apollo'
    };

  } catch (err) {
    console.error(`Apollo findMarketingContact failed:`, err.response?.data || err.message);
    return null;
  }
}

async function findCSuiteAtCompany(companyDomain) {
  const apiKey = process.env.APOLLO_API_KEY;
  const baseUrl = process.env.APOLLO_API_URL || 'https://api.apollo.io/v1';

  try {
    const searchResponse = await axios.post(
      `${baseUrl}/mixed_people/api_search`,
      {
        person_titles: CSUITE_FALLBACK,
        person_seniorities: ['c_suite'],
        q_organization_domains: companyDomain,
        person_locations: ['United States'],
        per_page: 5,
        page: 1
      },
      {
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const people = searchResponse.data?.people || [];
    console.log(`Apollo C-Suite search: ${people.length} contacts found at ${companyDomain}`);

    // Print out search results info
    for (const p of people) {
      console.log(` - ID: ${p.id} | Name: ${p.first_name} ${p.last_name || '[hidden]'} | Title: ${p.title} | Has Email: ${p.has_email}`);
    }

    const enrichable = people.filter(p => p.has_email === true);

    if (enrichable.length === 0) {
      console.log(`No enrichable C-Suite contacts found at ${companyDomain}.`);
      return null;
    }

    const target = enrichable[0];
    console.log(`Enriching C-Suite target: ${target.first_name} (ID: ${target.id})...`);

    const enrichResponse = await axios.post(
      `${baseUrl}/people/match`,
      {
        id: target.id,
        reveal_personal_emails: false
      },
      {
        headers: {
          'X-Api-Key': apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const person = enrichResponse.data?.person;
    if (!person) return null;

    return {
      first_name: person.first_name,
      last_name: person.last_name,
      email: person.email,
      email_status: person.email_status,
      title: person.title,
      linkedin_url: person.linkedin_url,
      source: 'Apollo (C-Suite fallback)'
    };

  } catch (err) {
    console.error(`Apollo findCSuite failed:`, err.response?.data || err.message);
    return null;
  }
}

// Run test if run directly
(async () => {
  const domain = process.argv[2] || 'boeing.com';
  console.log(`=== Testing Apollo Search Theory for: ${domain} ===`);
  const result = await findMarketingContactAtCompany(domain);
  console.log(`\nFinal Contact Result:\n`, JSON.stringify(result, null, 2));
})();
