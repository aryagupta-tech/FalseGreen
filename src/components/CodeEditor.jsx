"use client";

import dynamic from "next/dynamic";

const CodeMirrorClient = dynamic(() => import("./CodeMirrorClient"), {
  ssr: false,
  loading: () => (
    <div className="editor-loading" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </div>
  ),
});

export default function CodeEditor({ value, onChange, ariaLabel }) {
  return (
    <div className="editor-shell">
      <CodeMirrorClient value={value} onChange={onChange} ariaLabel={ariaLabel} />
    </div>
  );
}
