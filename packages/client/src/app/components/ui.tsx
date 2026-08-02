/**
 * "Cut Facets" primitives (docs/design/UI_UX.md §1): angular panels, gold-seam
 * buttons, labelled fields. Deliberately few — screens compose these.
 */

import { useId, type ReactNode } from 'react';

export const Panel = ({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}): React.JSX.Element => <div className={`panel ${className ?? ''}`}>{children}</div>;

export const Button = ({
  children,
  onClick,
  kind = 'primary',
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  kind?: 'primary' | 'ghost' | 'danger' | undefined;
  disabled?: boolean | undefined;
  type?: 'button' | 'submit' | undefined;
  title?: string | undefined;
}): React.JSX.Element => (
  <button
    className={`btn btn--${kind}`}
    onClick={onClick}
    disabled={disabled}
    type={type}
    title={title}
  >
    {children}
  </button>
);

export const TextField = ({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  maxLength,
  autoFocus,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password' | undefined;
  placeholder?: string | undefined;
  maxLength?: number | undefined;
  autoFocus?: boolean | undefined;
  hint?: string | undefined;
}): React.JSX.Element => {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="field__input"
        type={type}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      {hint ? <div className="field__hint">{hint}</div> : null}
    </div>
  );
};

export const Checkbox = ({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element => {
  const id = useId();
  return (
    <label className="checkbox" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className="checkbox__box" aria-hidden />
      {label}
    </label>
  );
};

export const ErrorLine = ({ message }: { message: string | null }): React.JSX.Element => (
  <div className="error-line" role="alert">
    {message ?? ' '}
  </div>
);

/** Swatch row (skin tones, hair colors, outfit tints). */
export const SwatchRow = ({
  label,
  colors,
  selected,
  onSelect,
}: {
  label: string;
  colors: readonly string[];
  selected: number;
  onSelect: (index: number) => void;
}): React.JSX.Element => (
  <div className="swatch-row">
    <div className="swatch-row__label">{label}</div>
    <div className="swatch-row__swatches">
      {colors.map((color, index) => (
        <button
          key={color + String(index)}
          type="button"
          className={`swatch${selected === index ? ' is-selected' : ''}`}
          style={{
            background: color === '#ffffff' ? 'linear-gradient(135deg,#d8d3c4,#8d8a7a)' : color,
          }}
          onClick={() => {
            onSelect(index);
          }}
          aria-label={`${label} option ${index + 1}`}
        />
      ))}
    </div>
  </div>
);

/** Compact horizontal choice chips (body, hairstyle, outfit). */
export const ChipRow = <T extends string>({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: readonly { id: T; name: string }[];
  selected: T;
  onSelect: (id: T) => void;
}): React.JSX.Element => (
  <div className="chip-row">
    <div className="chip-row__label">{label}</div>
    <div className="chip-row__chips">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className={`chip${selected === option.id ? ' is-selected' : ''}`}
          onClick={() => {
            onSelect(option.id);
          }}
        >
          {option.name}
        </button>
      ))}
    </div>
  </div>
);
