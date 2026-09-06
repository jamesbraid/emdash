/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptStatus } from './script-status';

afterEach(cleanup);

describe('ScriptStatus', () => {
  it('renders the in-progress indicator as four HTML dots, not animated SVG children', () => {
    const { container } = render(<ScriptStatus status="in-progress" />);

    const dots = container.querySelectorAll('[data-dot]');
    expect(dots).toHaveLength(4);
    for (const dot of dots) expect(dot.tagName).toBe('SPAN');
    expect(container.querySelector('circle')).toBeNull();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('keeps the other statuses as SVG glyphs', () => {
    for (const status of ['success', 'error', 'waiting', 'cancelled'] as const) {
      const { container, unmount } = render(<ScriptStatus status={status} />);
      expect(container.querySelector('svg')).not.toBeNull();
      expect(container.querySelector('[data-dot]')).toBeNull();
      unmount();
    }
  });
});
