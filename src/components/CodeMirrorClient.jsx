"use client";

import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

const extensions = [javascript(), EditorView.lineWrapping];

export default function CodeMirrorClient({ value, onChange, ariaLabel, readOnly = false }) {
  const labelEditor = (view) => {
    if (ariaLabel) view.contentDOM.setAttribute("aria-label", ariaLabel);
  };

  return (
    <div className="code-editor">
      <CodeMirror
        value={value ?? ""}
        height="220px"
        theme={oneDark}
        extensions={extensions}
        onChange={onChange}
        readOnly={readOnly}
        indentWithTab={false}
        aria-label={ariaLabel}
        onCreateEditor={labelEditor}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          highlightSelectionMatches: false,
          autocompletion: false,
          completionKeymap: false,
          searchKeymap: false,
          lintKeymap: false,
          closeBrackets: true,
          bracketMatching: true,
          indentOnInput: true,
          tabSize: 2,
        }}
      />
    </div>
  );
}
