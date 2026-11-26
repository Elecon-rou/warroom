import { Paperclip, X } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import {
  attachmentBytes,
  maxAttachmentBytes,
  maxAttachments,
  readDashboardAttachment,
  type DashboardAttachment,
} from './dashboardReferenceFiles';
export function DashboardAttachments({
  files,
  disabled,
  onChange,
  onError,
  onBusyChange,
  children,
}: {
  files: DashboardAttachment[];
  disabled: boolean;
  onChange: (files: DashboardAttachment[]) => void;
  onError: (error: string) => void;
  onBusyChange: (busy: boolean) => void;
  children: ReactNode;
}) {
  const [reading, setReading] = useState(false);
  const busy = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  async function add(incoming: File[]) {
    if (disabled || busy.current || !incoming.length) return;
    busy.current = true;
    setReading(true);
    onBusyChange(true);
    onError('');
    try {
      if (files.length + incoming.length > maxAttachments)
        throw new Error('Attach at most four files.');
      const added = await Promise.all(incoming.map(readDashboardAttachment));
      const all = [...files, ...added];
      if (all.reduce((sum, file) => sum + attachmentBytes(file), 0) > maxAttachmentBytes)
        throw new Error('Attachments must total at most 8 MiB.');
      if (
        all
          .filter((file) => file.mediaType === 'application/json')
          .reduce((sum, file) => sum + attachmentBytes(file), 0) >
        256 * 1024
      )
        throw new Error('JSON attachments must total at most 256 KiB.');
      onChange(all);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      busy.current = false;
      setReading(false);
      onBusyChange(false);
    }
  }
  return (
    <div
      className="dashboard-attachments"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void add(Array.from(e.dataTransfer.files));
      }}
      onPaste={(e) => {
        const incoming = Array.from(e.clipboardData.files);
        if (incoming.length) {
          e.preventDefault();
          void add(incoming);
        }
      }}
    >
      {children}
      <div className="dashboard-attachment-toolbar">
        <button
          className="subtle-button"
          type="button"
          disabled={disabled || reading || files.length >= maxAttachments}
          onClick={() => picker.current?.click()}
        >
          <Paperclip size={14} />
          {reading ? 'Reading files…' : 'Attach files'}
        </button>
        <input
          ref={picker}
          type="file"
          hidden
          multiple
          accept="image/png,image/jpeg,application/json,.json"
          aria-label="Attach screenshots or JSON files"
          disabled={disabled || reading}
          onChange={(e) => {
            void add(Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
        <span>PNG/JPEG · JSON · paste or drop files · up to 4 files / 8 MiB total</span>
      </div>
      <div className="dashboard-attachment-list">
        {files.map((file, index) => (
          <div className="dashboard-attachment" key={`${index}-${file.name}`}>
            {file.mediaType === 'application/json' ? (
              <details>
                <summary>{file.name}</summary>
                <pre>
                  {file.data.slice(0, 4000)}
                  {file.data.length > 4000 ? '\n…' : ''}
                </pre>
              </details>
            ) : (
              <>
                <img
                  src={`data:${file.mediaType};base64,${file.data}`}
                  alt={`Screenshot reference: ${file.name}`}
                />
                <span>{file.name}</span>
              </>
            )}
            <small>{Math.ceil(attachmentBytes(file) / 1024)} KiB</small>
            <button
              disabled={disabled || reading}
              aria-label={`Remove attachment ${file.name}`}
              onClick={() => onChange(files.filter((_, i) => i !== index))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
