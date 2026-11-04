import { useState, useEffect, useRef } from 'react';
import { Html5QrcodeScanner } from 'html5-qrcode';
import { recordAttendance } from '../lib/api';
import type { Profile } from '../lib/types';
import { timeLocal } from '../lib/date';
import { Camera, CheckCircle2, Clock3, ShieldCheck } from 'lucide-react';

export default function Employee({ profile }: { profile: Profile }) {
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<'success' | 'error' | ''>('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [recorded, setRecorded] = useState('');
  const busyRef = useRef(false);

  useEffect(() => {
    if (done) return;
    const scanner = new Html5QrcodeScanner(
      'reader',
      {
        fps: 10,
        qrbox: { width: 230, height: 230 },
        rememberLastUsedCamera: true,
        aspectRatio: 1.0,
      },
      false
    );

    scanner.render(
      async (decoded) => {
        if (busyRef.current || done) return;
        busyRef.current = true;
        setBusy(true);
        try {
          const res = await recordAttendance(decoded);
          if (!res?.success) {
            throw new Error(res?.message || 'Attendance could not be recorded.');
          }
          setMessage(res.message || 'Your attendance has been recorded.');
          setKind('success');
          setRecorded(res.time_in || '');
          setDone(true);
          await scanner.clear();
        } catch (e: any) {
          setMessage(e.message || 'Invalid or expired QR code. Please scan the current office QR.');
          setKind('error');
          setTimeout(() => {
            busyRef.current = false;
            setBusy(false);
          }, 2000);
        }
      },
      () => {}
    );

    return () => {
      scanner.clear().catch(() => {});
    };
  }, [done]);

  return (
    <main className="page employee-page">
      <div className="welcome-row">
        <div>
          <p className="eyebrow">EMPLOYEE CHECK-IN</p>
          <h1>Hello, {profile.full_name.split(' ')[0]}</h1>
          <p className="muted">Scan the current office QR code to record your arrival.</p>
        </div>
        <div className="avatar">{profile.full_name.slice(0, 1).toUpperCase()}</div>
      </div>
      <section className="scan-card">
        <div className="scan-heading">
          <span className="soft-icon">
            <Camera />
          </span>
          <div>
            <h2>Scan office QR code</h2>
            <p className="muted">Allow camera access when prompted.</p>
          </div>
        </div>
        {done ? (
          <div className="success-panel">
            <CheckCircle2 size={42} />
            <h2>Attendance recorded!</h2>
            <p>{message}</p>
            <div className="recorded-time">
              <Clock3 size={18} />
              <strong>{recorded ? timeLocal(recorded) : 'Recorded'}</strong>
              <span>Time In · Mogadishu time</span>
            </div>
          </div>
        ) : (
          <>
            <div id="reader" className="qr-reader" />
            <div className="scan-hint">
              <ShieldCheck size={17} /> Only a valid, active office QR code is accepted.
            </div>
          </>
        )}
        {message && !done && <div className={`alert ${kind}`}>{message}</div>}
      </section>
      <p className="tiny muted center">
        Employee ID: {profile.employee_code} · Attendance is recorded using server time.
      </p>
    </main>
  );
}
