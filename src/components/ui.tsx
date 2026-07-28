// src/components/ui.tsx — 小さな共通パーツ
import React from 'react';

/** 指で押せる大きさのトグルスイッチ。checkbox より当たり判定が広い */
export const Switch: React.FC<{
  checked: boolean;
  onChange: (v: boolean) => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
}> = ({ checked, onChange, label, hint }) => (
  <div>
    <div
      className="switch"
      role="switch"
      aria-checked={checked}
      tabIndex={0}
      onClick={() => onChange(!checked)}
      onKeyDown={e => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onChange(!checked);
        }
      }}
    >
      <div className={`switch__track ${checked ? 'is-on' : ''}`}>
        <div className="switch__knob" />
      </div>
      <span className="switch__label">{label}</span>
    </div>
    {hint && <div className="hint" style={{ marginTop: -4 }}>{hint}</div>}
  </div>
);

/** ラベル付きスライダー */
export const Slider: React.FC<{
  label: React.ReactNode;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  hint?: React.ReactNode;
  disabled?: boolean;
}> = ({ label, value, display, min, max, step, onChange, hint, disabled }) => (
  <div>
    <div className="row-between" style={{ fontSize: '0.81rem', color: 'var(--text-secondary)' }}>
      <span>{label}</span>
      <span className="mono" style={{ color: 'var(--text-primary)', fontWeight: 700 }}>{display}</span>
    </div>
    <input
      type="range" min={min} max={max} step={step} value={value} disabled={disabled}
      onChange={e => onChange(parseFloat(e.target.value))}
    />
    {hint && <div className="hint">{hint}</div>}
  </div>
);

/** 見出し付きのカード */
export const Card: React.FC<{
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, right, children }) => (
  <div className="card">
    {title && (
      <div className="row-between" style={{ marginBottom: 10 }}>
        <div className="card__title" style={{ marginBottom: 0 }}>{title}</div>
        {right}
      </div>
    )}
    {children}
  </div>
);
