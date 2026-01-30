import AdminPage from './pages/AdminPage'
import './App.css'

function handleLogout() {
  // Navigate to logout endpoint which clears cookies and redirects to login
  window.location.href = '/logout'
}

export default function App() {
  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <img src="/logo-small.png" alt="Moltworker" className="header-logo" />
          <h1>Moltbot Admin</h1>
        </div>
        <div className="header-right">
          <button className="btn btn-logout" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>
      <main className="app-main">
        <AdminPage />
      </main>
    </div>
  )
}
