import { useEffect, useState, useRef } from 'react';
import { Routes, Route, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { generateQrToken, createEmployeeAccount } from '../lib/api';
import type { Attendance, Profile } from '../lib/types';
import { todayLocal, timeLocal, dateLabel, isFridayLocal } from '../lib/date';
import {
  Users,
  UserCheck,
  UserX,
  Clock3,
  Plus,
  Download,
  RefreshCw,
  Search,
  RotateCw,
  Pin,
  Hand,
  Printer,
  Sparkles,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import * as XLSX from 'xlsx';

function Dashboard() {
  const [rows, setRows] = useState<Attendance[]>([]);
  const [staff, setStaff] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [lateAt, setLateAt] = useState('08:00');

  const load = async () => {
    setLoading(true);
    const [{ data: a }, { data: p }, { data: s }] = await Promise.all([
      supabase
        .from('attendance')
        .select('*, profiles!attendance_employee_id_fkey(full_name,employee_code,department)')
        .eq('work_date', todayLocal())
        .order('time_in'),
      supabase.from('profiles').select('*').eq('role', 'employee').eq('is_active', true),
      supabase
        .from('app_settings')
        .select('setting_value')
        .eq('setting_key', 'late_after')
        .maybeSingle(),
    ]);
    setRows((a || []) as any);
    setStaff((p || []) as Profile[]);
    if (s?.setting_value) setLateAt(s.setting_value);
    setLoading(false);
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel('attendance-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, []);

  const present = rows.length;
  const late = rows.filter((r) => r.status === 'late').length;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h1>Attendance dashboard</h1>
          <p className="muted">
            {dateLabel(todayLocal())} ·{' '}
            {isFridayLocal() ? 'Weekly day off' : 'Live attendance monitoring'}
          </p>
        </div>
        <button className="secondary" onClick={load}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
      <div className="stats-grid">
        <Stat icon={<Users />} label="Active employees" value={staff.length} />
        <Stat icon={<UserCheck />} label="Present today" value={present} tone="green" />
        <Stat icon={<Clock3 />} label="Late arrivals" value={late} tone="amber" />
        <Stat
          icon={<UserX />}
          label="Not checked in"
          value={isFridayLocal() ? 0 : Math.max(0, staff.length - present)}
          tone="red"
        />
      </div>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Today's arrivals</h2>
            <p className="muted">Late threshold: {lateAt} · Africa/Mogadishu</p>
          </div>
          <Link className="text-link" to="/admin/reports">
            View reports →
          </Link>
        </div>
        {loading ? <p className="muted">Loading records…</p> : <AttendanceTable rows={rows} />}
      </section>
    </>
  );
}

function Stat({
  icon,
  label,
  value,
  tone = 'blue',
}: {
  icon: any;
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="stat-card">
      <span className={`stat-icon ${tone}`}>{icon}</span>
      <div>
        <p className="muted">{label}</p>
        <strong>{value}</strong>
      </div>
    </div>
  );
}

function AttendanceTable({ rows }: { rows: Attendance[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Employee ID</th>
            <th>Department</th>
            <th>Time In</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                No attendance recorded yet today.
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.profiles?.full_name || 'Employee'}</strong>
                </td>
                <td>{r.profiles?.employee_code || '—'}</td>
                <td>{r.profiles?.department || '—'}</td>
                <td>{timeLocal(r.time_in)}</td>
                <td>
                  <span className={`status ${r.status}`}>
                    {r.status === 'late' ? 'Late' : 'Present'}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Employees() {
  const [list, setList] = useState<Profile[]>([]);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState<'success' | 'error'>('success');
  const [q, setQ] = useState('');
  const [form, setForm] = useState({
    full_name: '',
    employee_code: '',
    username: '',
    password: '',
    department: '',
  });

  const load = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'employee')
      .order('full_name');
    setList((data || []) as Profile[]);
  };

  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      const data = await createEmployeeAccount(form);
      setMsgType('success');
      setMsg(data.message || 'Employee account created successfully.');
      setForm({ full_name: '', employee_code: '', username: '', password: '', department: '' });
      setShow(false);
      await load();
    } catch (err: any) {
      setMsgType('error');
      setMsg(err.message || 'Could not create employee.');
    } finally {
      setBusy(false);
    }
  };

  const filtered = list.filter((x) =>
    (x.full_name + ' ' + x.employee_code + ' ' + (x.department || ''))
      .toLowerCase()
      .includes(q.toLowerCase())
  );

  const toggle = async (p: Profile) => {
    const { error } = await supabase
      .from('profiles')
      .update({ is_active: !p.is_active })
      .eq('id', p.id);
    if (error) alert(error.message);
    else load();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">PEOPLE</p>
          <h1>Employees</h1>
          <p className="muted">Create and manage employee accounts.</p>
        </div>
        <button className="primary" onClick={() => setShow(!show)}>
          <Plus size={17} /> Add employee
        </button>
      </div>
      {msg && <div className={`alert ${msgType}`}>{msg}</div>}
      {show && (
        <form className="panel form-grid" onSubmit={add}>
          <h2 className="span-2">New employee account</h2>
          <label>
            Full name
            <input
              required
              value={form.full_name}
              onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            />
          </label>
          <label>
            Employee ID
            <input
              required
              value={form.employee_code}
              onChange={(e) => setForm({ ...form, employee_code: e.target.value })}
            />
          </label>
          <label>
            Username
            <input
              required
              pattern="[A-Za-z0-9._-]+"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              placeholder="e.g. ahmed01"
            />
          </label>
          <label>
            Temporary password
            <input
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          <label className="span-2">
            Department (optional)
            <input
              value={form.department}
              onChange={(e) => setForm({ ...form, department: e.target.value })}
            />
          </label>
          <div className="span-2">
            <button className="primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create account'}
            </button>
          </div>
        </form>
      )}
      <section className="panel">
        <div className="panel-head">
          <h2>Employee directory ({list.length})</h2>
          <div className="searchbox">
            <Search size={16} />
            <input
              placeholder="Search employees"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Employee ID</th>
                <th>Username</th>
                <th>Department</th>
                <th>Account</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong>{p.full_name}</strong>
                  </td>
                  <td>{p.employee_code}</td>
                  <td>{p.username}</td>
                  <td>{p.department || '—'}</td>
                  <td>
                    <span className={`status ${p.is_active ? 'present' : 'late'}`}>
                      {p.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    <button className="small-btn" onClick={() => toggle(p)}>
                      {p.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

type QrMode = 'auto' | 'manual' | 'fixed';

function QrDisplay() {
  const [mode, setMode] = useState<QrMode>(() => {
    return (localStorage.getItem('qr_mode') as QrMode) || 'auto';
  });
  const [intervalSec, setIntervalSec] = useState<number>(() => {
    const saved = localStorage.getItem('qr_interval');
    return saved ? Math.max(10, parseInt(saved, 10)) : 25;
  });
  const [customInterval, setCustomInterval] = useState(String(intervalSec));

  const [payload, setPayload] = useState('');
  const [expires, setExpires] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(intervalSec);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const intervalRef = useRef(intervalSec);
  intervalRef.current = intervalSec;

  const handleModeChange = (newMode: QrMode) => {
    setMode(newMode);
    localStorage.setItem('qr_mode', newMode);
  };

  const handleIntervalChange = (val: number) => {
    const clamped = Math.max(10, Math.min(3600, val));
    setIntervalSec(clamped);
    setCustomInterval(String(clamped));
    localStorage.setItem('qr_interval', String(clamped));
    setCountdown(clamped);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      // Calculate token lifetime based on mode:
      // Fixed: 1 year (31,536,000 seconds)
      // Manual: 24 hours (86,400 seconds)
      // Auto: interval + 25 seconds
      const durationSeconds =
        modeRef.current === 'fixed'
          ? 31536000
          : modeRef.current === 'manual'
          ? 86400
          : intervalRef.current + 25;

      const data = await generateQrToken(durationSeconds);
      setPayload(data.token);
      setExpires(data.expires_at);
      setErr('');
      if (modeRef.current === 'auto') {
        setCountdown(intervalRef.current);
      }
    } catch (e: any) {
      setErr(e.message || 'Unable to generate QR.');
    } finally {
      setLoading(false);
    }
  };

  // Re-fetch token whenever mode or interval changes
  useEffect(() => {
    refresh();
  }, [mode, intervalSec]);

  // Handle auto-rotation interval
  useEffect(() => {
    if (mode !== 'auto') return;
    const timer = setInterval(() => {
      refresh();
    }, intervalSec * 1000);
    return () => clearInterval(timer);
  }, [mode, intervalSec]);

  // Handle 1-second countdown ticker
  useEffect(() => {
    if (mode !== 'auto') return;
    const ticker = setInterval(() => {
      setCountdown((prev) => (prev > 1 ? prev - 1 : intervalSec));
    }, 1000);
    return () => clearInterval(ticker);
  }, [mode, intervalSec]);

  const printQR = () => {
    window.print();
  };

  return (
    <div className="qr-page">
      <div className="page-head">
        <div>
          <p className="eyebrow">OFFICE CHECK-IN</p>
          <h1>Office QR Display</h1>
          <p className="muted">Configure rotation behavior and display or print your QR code.</p>
        </div>
        <button className="secondary" onClick={refresh} disabled={loading}>
          <RefreshCw size={16} /> {loading ? 'Refreshing…' : 'Regenerate QR'}
        </button>
      </div>

      {/* Mode Controls */}
      <div className="qr-config-panel">
        <p className="eyebrow" style={{ textAlign: 'center', marginBottom: '8px' }}>
          CHOOSE QR CODE BEHAVIOR
        </p>
        <div className="qr-mode-selector">
          <button
            type="button"
            className={`qr-mode-tab ${mode === 'auto' ? 'active' : ''}`}
            onClick={() => handleModeChange('auto')}
          >
            <RotateCw size={15} /> Auto Every {intervalSec}s
          </button>
          <button
            type="button"
            className={`qr-mode-tab ${mode === 'manual' ? 'active' : ''}`}
            onClick={() => handleModeChange('manual')}
          >
            <Hand size={15} /> Change On Demand
          </button>
          <button
            type="button"
            className={`qr-mode-tab ${mode === 'fixed' ? 'active' : ''}`}
            onClick={() => handleModeChange('fixed')}
          >
            <Pin size={15} /> Fixed (Permanent)
          </button>
        </div>

        {/* Sub-controls based on active mode */}
        {mode === 'auto' && (
          <div style={{ textAlign: 'center' }}>
            <p className="tiny muted">Select how often the QR code automatically refreshes:</p>
            <div className="interval-row">
              {[15, 25, 30, 60, 120, 300].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`interval-btn ${intervalSec === s ? 'active' : ''}`}
                  onClick={() => handleIntervalChange(s)}
                >
                  {s >= 60 ? `${s / 60}m` : `${s}s`}
                </button>
              ))}
              <div className="interval-custom">
                <span>Custom:</span>
                <input
                  type="number"
                  min="10"
                  max="3600"
                  value={customInterval}
                  onChange={(e) => setCustomInterval(e.target.value)}
                  onBlur={() => {
                    const num = parseInt(customInterval, 10);
                    if (!isNaN(num)) handleIntervalChange(num);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const num = parseInt(customInterval, 10);
                      if (!isNaN(num)) handleIntervalChange(num);
                    }
                  }}
                />
                <span>sec</span>
              </div>
            </div>
          </div>
        )}

        {mode === 'manual' && (
          <p className="tiny muted center">
            This QR code stays valid for 24 hours and <strong>only changes when you click 'Regenerate QR'</strong>.
          </p>
        )}

        {mode === 'fixed' && (
          <div style={{ textAlign: 'center' }}>
            <p className="tiny muted">
              This QR code is <strong>permanent</strong> (valid for 1 year). Perfect for printing and framing on a wall or reception desk.
            </p>
            <div className="qr-action-row">
              <button className="primary" onClick={printQR}>
                <Printer size={16} /> Print QR Poster
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Printable Heading for printouts */}
      <h1 className="print-only-title">Office Attendance Check-In</h1>
      <p className="print-only-sub">Scan this QR code with your phone camera to record Time In.</p>

      {/* Main QR Display Card */}
      <section className="qr-display-card">
        <div
          className="live-label"
          style={{
            background: mode === 'fixed' ? '#eaf3fb' : mode === 'manual' ? '#fff4df' : '#e8f8ef',
            color: mode === 'fixed' ? '#176aa8' : mode === 'manual' ? '#b7791f' : '#18784a',
          }}
        >
          <span
            className="live-dot"
            style={{
              background: mode === 'fixed' ? '#176aa8' : mode === 'manual' ? '#b7791f' : '#20a35b',
            }}
          />{' '}
          {mode === 'fixed'
            ? 'PERMANENT FIXED QR'
            : mode === 'manual'
            ? 'STATIC (CHANGE ON DEMAND)'
            : 'LIVE ROTATING QR'}
        </div>

        {payload ? (
          <>
            <div className="qr-code-box">
              <QRCodeSVG value={payload} size={280} level="H" includeMargin />
            </div>
            <h2>Scan to record Time In</h2>
            <p className="muted">
              {mode === 'fixed'
                ? 'Permanent QR code. Employees can scan anytime.'
                : mode === 'manual'
                ? 'Only updates when an administrator refreshes it.'
                : `Automatically changes every ${intervalSec} seconds.`}
            </p>

            <div className="expiry">
              {mode === 'fixed' ? (
                <>
                  <Pin size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                  <strong>Fixed permanent QR</strong>
                </>
              ) : mode === 'manual' ? (
                <>
                  <Hand size={14} style={{ verticalAlign: 'middle', marginRight: '4px' }} />
                  <strong>Changes when you say</strong>
                </>
              ) : (
                <>
                  Rotates in <strong>{countdown}s</strong>
                </>
              )}
            </div>
          </>
        ) : (
          <p style={{ margin: '30px 0', color: err ? '#c34b4b' : '#62768b', lineHeight: '1.5' }}>
            {loading ? 'Generating secure QR…' : err}
          </p>
        )}

        <p className="tiny muted">
          Only signed-in employees can use this QR.
        </p>
      </section>
    </div>
  );
}

function Reports() {
  const [from, setFrom] = useState(todayLocal().slice(0, 8) + '01');
  const [to, setTo] = useState(todayLocal());
  const [rows, setRows] = useState<Attendance[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('attendance')
      .select('*, profiles!attendance_employee_id_fkey(full_name,employee_code,department)')
      .gte('work_date', from)
      .lte('work_date', to)
      .order('work_date')
      .order('time_in');
    if (error) alert(error.message);
    setRows((data || []) as any);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const csv = () => {
    const lines = [
      ['Date', 'Employee', 'Employee ID', 'Department', 'Time In', 'Status'],
      ...rows.map((r) => [
        r.work_date,
        r.profiles?.full_name || '',
        r.profiles?.employee_code || '',
        r.profiles?.department || '',
        timeLocal(r.time_in),
        r.status,
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(lines);
    ws['!cols'] = [
      { wch: 14 },
      { wch: 28 },
      { wch: 18 },
      { wch: 20 },
      { wch: 16 },
      { wch: 12 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance');
    XLSX.writeFile(wb, `attendance_${from}_to_${to}.xlsx`);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow">RECORDS</p>
          <h1>Attendance reports</h1>
          <p className="muted">Filter records and export a formatted Excel workbook.</p>
        </div>
        <button className="primary" onClick={csv} disabled={!rows.length}>
          <Download size={17} /> Export Excel
        </button>
      </div>
      <section className="panel">
        <div className="filters">
          <label>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button className="secondary" onClick={load}>
            <RefreshCw size={16} /> Apply filter
          </button>
        </div>
        <div className="panel-head">
          <h2>{rows.length} attendance records</h2>
          <span className="muted">
            {from} — {to}
          </span>
        </div>
        {loading ? <p className="muted">Loading…</p> : <AttendanceTable rows={rows} />}
      </section>
    </>
  );
}

export default function Admin({ profile }: { profile: Profile }) {
  return (
    <main className="page admin-page">
      <div className="admin-welcome">
        <div>
          <span className="eyebrow">ADMINISTRATION</span>
          <p>
            Signed in as <strong>{profile.full_name}</strong>
          </p>
        </div>
        <span className="admin-tag">Administrator</span>
      </div>
      <Routes>
        <Route index element={<Dashboard />} />
        <Route path="employees" element={<Employees />} />
        <Route path="qr" element={<QrDisplay />} />
        <Route path="reports" element={<Reports />} />
      </Routes>
    </main>
  );
}
