import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { useEffect } from 'react'
import Home from './pages/Home'
import Login from './pages/Login'
import ResetPassword from './pages/ResetPassword'
import SignalsTable from './pages/SignalsTable'
import SignalDetail from './pages/SignalDetail'
import AddContact from './pages/AddContact'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import ErrorBoundary from './components/ErrorBoundary'

// Intercepts Supabase recovery tokens in the URL hash and sends them to /reset-password
function RecoveryRedirect() {
  const navigate = useNavigate()
  useEffect(() => {
    const hash = window.location.hash
    if (hash && (hash.includes('type=recovery') || hash.includes('access_token')) && !window.location.pathname.includes('reset-password')) {
      navigate('/reset-password' + hash, { replace: true })
    }
  }, [navigate])
  return null
}

export default function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <RecoveryRedirect />
      <Routes>
        {/* Public — no sidebar */}
        <Route path="/"               element={<Home />} />
        <Route path="/login"          element={<Login />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* Authenticated — wrapped in sidebar Layout */}
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/signals"       element={<SignalsTable />} />
          <Route path="/signals/:id"   element={<SignalDetail />} />
          <Route path="/add-contact"   element={<AddContact />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  )
}
