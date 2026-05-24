'use client';
import dynamic from 'next/dynamic';

const MonacoEditor = dynamic(() => import('@monaco-editor/react').then((m) => m.Editor), { ssr: false });

interface Props {
  value: string;
  onChange: (v: string) => void;
  language?: string;
  height?: number;
  placeholder?: string;
}

export function PromptEditor({ value, onChange, language = 'markdown', height = 280 }: Props) {
  return (
    <div className="overflow-hidden rounded border border-hive-border bg-black/60">
      <MonacoEditor
        height={height}
        language={language}
        value={value}
        onChange={(v) => onChange(v ?? '')}
        theme="vs-dark"
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          lineNumbers: 'off',
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'none',
          folding: false,
          padding: { top: 8, bottom: 8 },
        }}
      />
    </div>
  );
}
