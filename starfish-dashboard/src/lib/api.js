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

// If the backend returns 401, the session has expired or is invalid.
// Redirect to /login silently — don't show an error, just ask them to log in again.
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      window.location.href = '/login'
      return new Promise(() => {}) // suspend the rejected promise so callers don't also show an error
    }
    return Promise.reject(error)
  }
)

export default api
