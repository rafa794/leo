import type { CSSProperties, InputHTMLAttributes } from 'react';

/**
 * Slider with a professional look (instead of the browser's blue one):
 * thin neutral track, colored fill and a white knob.
 *  - bipolar sliders (min < 0 < max) fill from the center, like color adjustments in pro editors
 *  - `tone` paints the track with what it changes (temperature, tint, saturation)
 */
export type RangeTone = 'temp' | 'tint' | 'saturation';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'min' | 'max' | 'value'> & {
  min: number;
  max: number;
  value: number;
  tone?: RangeTone;
};

export default function Range({ min, max, value, tone, className, style, ...rest }: Props) {
  const span = max - min || 1;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - min) / span) * 100));
  const zero = min < 0 && max > 0 ? pct(0) : 0;
  const at = pct(value);
  const vars = { '--a': `${Math.min(zero, at)}%`, '--b': `${Math.max(zero, at)}%`, '--z': `${zero}%` } as CSSProperties;
  return (
    <input
      type="range"
      min={min}
      max={max}
      value={value}
      className={`range ${tone ? `tone-${tone}` : ''} ${min < 0 && max > 0 ? 'bipolar' : ''} ${className ?? ''}`}
      style={{ ...vars, ...style }}
      {...rest}
    />
  );
}
