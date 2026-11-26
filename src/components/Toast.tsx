import { useEffect } from 'react';
import { useEditor } from '../store/editor';

export default function Toast() {
  const status = useEditor((s) => s.status);
  const setStatus = useEditor((s) => s.setStatus);
  useEffect(() => {
    if (!status || status.endsWith('…')) return;
    const t = setTimeout(() => setStatus(null), 2500);
    return () => clearTimeout(t);
  }, [status, setStatus]);
  return status ? <div className="toast">{status}</div> : null;
}
