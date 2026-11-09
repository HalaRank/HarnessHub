import { type ReactNode, useEffect, useRef } from "react";

export function Confirm({
  title,
  children,
  confirm,
  cancel,
  disabled = false,
  label = "确认",
}: {
  title: string;
  children: ReactNode;
  confirm: () => void;
  cancel: () => void;
  disabled?: boolean;
  label?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const consumed = useRef(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const dismiss = () => {
    consumed.current = true;
    cancel();
  };
  return (
    <dialog
      ref={dialog}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        dismiss();
      }}
    >
      <h2>{title}</h2>
      {children}
      <footer>
        <button type="button" onClick={dismiss}>
          取消
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (consumed.current || disabled) return;
            consumed.current = true;
            confirm();
          }}
        >
          {label}
        </button>
      </footer>
    </dialog>
  );
}
