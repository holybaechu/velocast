import React from "react";
import { Easing, Sequence, useCurrentFrame } from "@velocast/react";

const easeFade = Easing.inOut(Easing.ease);

export function BrandMark({ color = "#d6e8b7", size = 36 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      aria-label="Fieldnote mark"
    >
      <path d="M5 29V7h8v14h8v8ZM23 7h8v8h-8Z" fill={color} />
    </svg>
  );
}

export function ProgressRing({ progress, size = 260, color = "#d6e8b7" }) {
  const circumference = 2 * Math.PI * 100;
  return (
    <svg width={size} height={size} viewBox="0 0 240 240" aria-label="Progress">
      <circle
        cx="120"
        cy="120"
        r="100"
        fill="none"
        stroke="#ffffff1c"
        strokeWidth="10"
      />
      <circle
        cx="120"
        cy="120"
        r="100"
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={
          circumference * (1 - Math.max(0, Math.min(1, progress)))
        }
        transform="rotate(-90 120 120)"
      />
      <text
        x="120"
        y="133"
        textAnchor="middle"
        fontFamily="Arial, sans-serif"
        fontSize="42"
        fill={color}
      >
        {Math.round(progress * 100)}%
      </text>
    </svg>
  );
}

function Fade({ durationFrames, fadeFrames, exit, children }) {
  const frame = useCurrentFrame();
  const fade = Math.max(1, fadeFrames);
  const progress = Math.max(
    0,
    Math.min(
      1,
      frame / fade,
      exit ? (durationFrames - fade - frame) / fade : 1,
    ),
  );
  const opacity = easeFade(progress);
  return (
    <section style={{ position: "absolute", inset: 0, opacity }}>
      {children}
    </section>
  );
}

// Overlap by fadeFrames. Text fades through the shared background at the cut,
// so outgoing and incoming headlines remain legible. Keep the closing scene visible.
export function Scene({
  from,
  durationFrames,
  fadeFrames = 15,
  exit = true,
  children,
}) {
  return (
    <Sequence from={from} durationFrames={durationFrames}>
      <Fade durationFrames={durationFrames} fadeFrames={fadeFrames} exit={exit}>
        {children}
      </Fade>
    </Sequence>
  );
}
