import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Home from './pages/Home'
import Login from './pages/Login'
import SignalsTable from './pages/SignalsTable'
import SignalDetail from './pages/SignalDetail'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import ErrorBoundary from './components/ErrorBoundary'

export default function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <Routes>
        {/* Public — no sidebar */}
        <Route path="/"      element={<Home />} />
        <Route path="/login" element={<Login />} />

        {/* Authenticated — wrapped in sidebar Layout */}
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/signals"     element={<SignalsTable />} />
          <Route path="/signals/:id" element={<SignalDetail />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
    </ErrorBoundary>
  )
}
