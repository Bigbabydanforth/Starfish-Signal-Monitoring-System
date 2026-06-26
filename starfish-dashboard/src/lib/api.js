// Axios instance pointed at the Express backend
// All signal reads, status updates, and HubSpot pushes go through here

import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000',
  headers: {
    // Sent on every request — server rejects POST/PATCH without this header.
    // Browsers cannot set custom headers cross-site without a CORS preflight,
    // which our CORS whitelist will block, preventing CSRF attacks.
    'X-Requested-With': 'XMLHttpRequest',
  },
})

export default api
