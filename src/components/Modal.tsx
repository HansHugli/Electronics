import { useEffect, useRef, useId, ReactNode } from 'react';
import { pushModal, popModal, updateModal, escapeTopModal, modalCount } from './modalStack';

// One capture-phase listener for the whole app: Escape closes the topmost
// modal and never reaches the board's own shortcut handler.
let escapeListenerInstalled = false;
function installEscapeListener() {
  if (escapeListenerInstalled || typeof window === 'undefined') return;
  escapeListenerInstalled = true;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || modalCount() === 0) return;
    e.preventDefault();
    e.stopPropagation();
    escapeTopModal();
  }, true);
}

/**
 * Registers a modal in the stack without drawing anything. For a dialog that
 * renders its own overlay (UsagePanel) so it still blocks shortcuts and gets
 * Escape.
 */
export function ModalLayer({ onClose, children }: { onClose?: () => void; children: ReactNode }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    installEscapeListener();
    const id = pushModal(() => onCloseRef.current?.());
    return () => popModal(id);
  }, []);
  return <>{children}</>;
}

interface ModalProps {
  /** Title shown at the top; also the dialog's accessible name. */
  title?: ReactNode;
  /** Escape calls this. Leave undefined for a dialog Escape must not dismiss. */
  onClose?: () => void;
  className?: string;
  children: ReactNode;
  /** Element id of the title when the caller renders its own heading. */
  labelledBy?: string;
  /** Extra header content right of the title (e.g. a close button). */
  headerExtra?: ReactNode;
}

/**
 * In-app modal. It never closes on a backdrop click (Hans's rule): only its
 * own buttons, or Escape when `onClose` is given. Text inside stays selectable.
 */
export default function Modal({ title, onClose, className, children, labelledBy, headerExtra }: ModalProps) {
  const autoId = useId();
  const titleId = labelledBy ?? `modal-title-${autoId}`;
  const dialogRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    installEscapeListener();
    const previouslyFocused = document.activeElement as HTMLElement | null;
    idRef.current = pushModal(onCloseRef.current ? () => onCloseRef.current?.() : undefined);
    // Move focus into the dialog (first field, else the dialog itself) unless
    // a child already took it (autoFocus).
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>(
        'input:not([type=hidden]):not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])',
      );
      (first ?? dialog).focus();
    }
    return () => {
      if (idRef.current !== null) popModal(idRef.current);
      idRef.current = null;
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, []);

  // Keep the Escape handler in step with whether onClose is set.
  useEffect(() => {
    if (idRef.current !== null) updateModal(idRef.current, onClose ? () => onCloseRef.current?.() : undefined);
  }, [onClose]);

  return (
    <div className="modal-overlay" role="presentation">
      <div
        ref={dialogRef}
        className={`modal ${className ?? ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title || labelledBy ? titleId : undefined}
        tabIndex={-1}
      >
        {(title || headerExtra) && (
          <div className="modal-header">
            {title && <h2 id={titleId} className="modal-title">{title}</h2>}
            {headerExtra}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

export interface ConfirmButton {
  label: string;
  kind?: 'primary' | 'danger' | 'secondary';
  onClick: () => void;
}

/** A question with explicit buttons, in place of window.confirm. */
export function ConfirmDialog({ title, message, buttons, onCancel }: {
  title: string;
  message: ReactNode;
  buttons: ConfirmButton[];
  /** Escape does this (normally the Cancel button's action). */
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} className="confirm-modal">
      <div className="confirm-message">{message}</div>
      <div className="modal-actions">
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            className={`modal-btn ${b.kind ?? ''}`}
            onClick={b.onClick}
          >
            {b.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}
