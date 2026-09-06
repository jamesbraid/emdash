import { Tooltip } from '@react/primitives/tooltip';
import { cx } from '@styles/utilities/cx';
import * as React from 'react';
import * as styles from './agent-status.css';

export type AgentStatusKind = 'working' | 'awaiting-input' | 'error' | 'completed' | 'idle';

type ActiveAgentStatusKind = Exclude<AgentStatusKind, 'idle'>;

export interface AgentStatusProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** An `idle` (or `null`) status renders nothing. */
  status: AgentStatusKind | null;
  /**
   * Uniform size shorthand. Sets the shared status bounding box.
   * Numbers are treated as CSS px values.
   */
  size?: string | number;
  /** Wrap the indicator in a tooltip naming the status. */
  tooltip?: boolean;
}

const STATUS_LABELS: Record<ActiveAgentStatusKind, string> = {
  working: 'Agent is working',
  'awaiting-input': 'Agent is awaiting input',
  error: 'Agent error',
  completed: 'Agent completed',
};

// The working glyph is a 3x3 grid of dots. They are plain elements rather than
// SVG children: Chromium runs opacity and transform animations on elements on
// the compositor thread, but SVG children are restyled and repainted on the
// renderer's main thread every frame, which with many working agents pinned it.
const WORKING_DOT_COUNT = 9;

function toCssLength(size: string | number) {
  return typeof size === 'number' ? `${size}px` : size;
}

function AgentStatus({
  status,
  size = '1.5rem',
  tooltip = false,
  className,
  style,
  role = 'img',
  'aria-label': ariaLabel,
  ...props
}: AgentStatusProps) {
  if (!status || status === 'idle') return null;

  const indicator = (
    <span
      {...props}
      role={role}
      aria-label={ariaLabel ?? STATUS_LABELS[status]}
      data-status={status}
      className={cx(styles.root, className)}
      style={
        {
          '--agent-status-size': toCssLength(size),
          ...style,
        } as React.CSSProperties
      }
    >
      <AgentStatusGlyph status={status} />
    </span>
  );

  if (!tooltip) return indicator;

  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={indicator} />
      <Tooltip.Content>{STATUS_LABELS[status]}</Tooltip.Content>
    </Tooltip.Root>
  );
}

function AgentStatusGlyph({ status }: { status: ActiveAgentStatusKind }) {
  switch (status) {
    case 'working':
      return (
        <span className={cx(styles.dotGrid, styles.workingIcon)} aria-hidden="true">
          {Array.from({ length: WORKING_DOT_COUNT }, (_, index) => (
            <span key={index} data-dot="" className={styles.dot[index]} />
          ))}
        </span>
      );

    case 'awaiting-input':
      return (
        <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
          <rect
            x="6"
            y="6"
            width="12"
            height="12"
            rx="1"
            className={styles.warningShape}
            strokeWidth="1"
            transform="rotate(45 12 12)"
          />
        </svg>
      );

    case 'completed':
      return (
        <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="7.5" className={styles.successShape} strokeWidth="1" />
        </svg>
      );

    case 'error':
      return (
        <svg className={styles.icon} viewBox="0 0 24 24" aria-hidden="true">
          <rect
            x="5"
            y="5"
            width="16"
            height="16"
            rx="1.5"
            className={styles.errorShape}
            strokeWidth="1"
          />
          <circle cx="13" cy="13" r="0.9" className={styles.errorMark} stroke="none" />
        </svg>
      );
  }
}

export { AgentStatus };
