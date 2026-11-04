import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { supabase, isSupabaseConfigured } from './lib/supabase';
import type { Profile } from './lib/types';
import Login from './pages/Login';
import Admin from './pages/Admin';
import Employee from './pages/Employee';
import { QrCode, LayoutDashboard, Users, LogOut, ClipboardList, AlertCircle } from 'lucide-react';

export default function App() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    let alive = true;

    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    const load = async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (session) {
          const { data } = await supabase
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .maybeSingle();
          if (alive) setProfile(data as Profile | null);
        }
      } catch (e) {
        console.error('Session load error:', e);
      } finally {
        if (alive) setLoading(false);
      }
    };

    load();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (_e, session) => {
      try {
        if (!session) {
          setProfile(null);
          return;
        }
        const { data } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', session.user.id)
          .maybeSingle();
        setProfile(data as Profile | null);
      } catch (e) {
        console.error('Auth state change error:', e);
      }
    });

    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
    setProfile(null);
    nav('/login');
  };

  if (!isSupabaseConfigured) {
    return (
      <main className="login-wrap">
        <div className="login-card" style={{ maxWidth: '540px' }}>
          <div className="login-logo" style={{ background: '#fff4df', color: '#b7791f' }}>
            <AlertCircle size={30} />
          </div>
          <p className="eyebrow" style={{ color: '#b7791f' }}>SETUP REQUIRED</p>
          <h1>Connect to Supabase</h1>
          <p className="muted">
            The app needs your Supabase project credentials to authenticate users and record attendance.
          </p>
          <div className="alert" style={{ background: '#f5f8fb', color: '#1f3853', fontSize: '12px', lineHeight: '1.6' }}>
            <strong>Step 1:</strong> Create or open your project at <code>https://supabase.com</code><br />
            <strong>Step 2:</strong> Copy your project URL & Anon Key from <strong>Settings &rarr; API</strong><br />
            <strong>Step 3:</strong> Put them in a <code>.env.local</code> file in this project:
            <pre style={{ margin: '8px 0 0', padding: '10px', background: '#102a43', color: '#d9e6f2', borderRadius: '8px', overflowX: 'auto', fontSize: '11px' }}>
              VITE_SUPABASE_URL=https://your-project.supabase.co&#10;VITE_SUPABASE_ANON_KEY=your-anon-key
            </pre>
          </div>
          <p className="tiny muted">
            Once saved, restart the Vite dev server to load the new credentials.
          </p>
        </div>
      </main>
    );
  }

  if (loading) {
    return <div className="center-screen">Loading attendance portal…</div>;
  }

  return (
    <>
      {profile && (
        <header className="topbar">
          <Link to={profile.role === 'admin' ? '/admin' : '/employee'} className="brand">
            <span className="brand-icon">
              <QrCode size={21} />
            </span>{' '}
            Attendance Portal
          </Link>
          <div className="top-actions">
            <span className="user-chip">
              {profile.full_name} · {profile.role}
            </span>
            <button className="icon-btn" onClick={signOut} title="Sign out">
              <LogOut size={18} />
            </button>
          </div>
        </header>
      )}

      <Routes>
        <Route
          path="/login"
          element={profile ? <Navigate to={profile.role === 'admin' ? '/admin' : '/employee'} /> : <Login />}
        />
        <Route
          path="/"
          element={<Navigate to={profile ? (profile.role === 'admin' ? '/admin' : '/employee') : '/login'} />}
        />
        <Route
          path="/admin/*"
          element={profile?.role === 'admin' ? <Admin profile={profile} /> : <Navigate to="/login" />}
        />
        <Route
          path="/employee"
          element={profile?.role === 'employee' ? <Employee profile={profile} /> : <Navigate to="/login" />}
        />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>

      {profile?.role === 'admin' && (
        <nav className="bottom-nav">
          <Link to="/admin">
            <LayoutDashboard size={18} />
            Dashboard
          </Link>
          <Link to="/admin/employees">
            <Users size={18} />
            Employees
          </Link>
          <Link to="/admin/qr">
            <QrCode size={18} />
            QR Display
          </Link>
          <Link to="/admin/reports">
            <ClipboardList size={18} />
            Reports
          </Link>
        </nav>
      )}
    </>
  );
}
