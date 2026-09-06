/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentStatus } from './agent-status';

afterEach(cleanup);

describe('AgentStatus', () => {
  it('renders the working indicator as nine HTML dots, not animated SVG children', () => {
    // Transforms and opacity on SVG children animate on the main thread; on
    // plain elements the compositor handles them. With dozens of working
    // agents this is the difference between an idle and a pinned renderer.
    const { container } = render(<AgentStatus status="working" />);

    const dots = container.querySelectorAll('[data-dot]');
    expect(dots).toHaveLength(9);
    for (const dot of dots) expect(dot.tagName).toBe('SPAN');
    expect(container.querySelector('circle')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('keeps the static statuses as SVG glyphs', () => {
    for (const status of ['awaiting-input', 'completed', 'error'] as const) {
      const { container, unmount } = render(<AgentStatus status={status} />);
      expect(container.querySelector('svg')).not.toBeNull();
      expect(container.querySelector('[data-dot]')).toBeNull();
      unmount();
    }
  });

  it('labels the working indicator for assistive tech', () => {
    const { getByRole } = render(<AgentStatus status="working" />);
    expect(getByRole('img', { name: 'Agent is working' })).toBeTruthy();
  });
});
