import { createElement, type SelectHTMLAttributes } from "react";

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props}>
      <button type="button">
        {createElement("selectedcontent", { className: "select-value" })}
      </button>
      {children}
    </select>
  );
}
