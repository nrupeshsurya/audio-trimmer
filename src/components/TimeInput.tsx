import { useEffect, useRef, useState } from "react";
import { formatTime, parseTime } from "../lib/time";

interface Props {
  value: number;
  onCommit: (t: number) => void;
  disabled?: boolean;
}

/** A timestamp field that shows `value` and commits a parsed time on Enter or blur. */
export default function TimeInput({ value, onCommit, disabled }: Props) {
  const [text, setText] = useState(formatTime(value));
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) setText(formatTime(value));
  }, [value, editing]);

  const finish = () => {
    setEditing(false);
    const t = parseTime(text);
    if (cancelled.current || t === null) setText(formatTime(value));
    else if (Math.abs(t - value) > 1e-4) onCommit(t);
    cancelled.current = false;
  };

  return (
    <input
      className={`time-input ${editing && parseTime(text) === null ? "invalid" : ""}`}
      value={text}
      disabled={disabled}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onFocus={(e) => {
        setEditing(true);
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
