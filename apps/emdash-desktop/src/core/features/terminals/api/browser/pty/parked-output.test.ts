import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createParkedOutput } from './parked-output';

function harness(lingerMs = 1000) {
  const park = vi.fn();
  const resume = vi.fn();
  const parked = createParkedOutput({ lingerMs, park, resume });
  return { parked, park, resume };
}

describe('createParkedOutput', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps streaming while a terminal is remounted within the linger', () => {
    const { parked, park, resume } = harness(1000);
    parked.mount();
    parked.connected();

    parked.unmount();
    vi.advanceTimersByTime(999);
    parked.mount();
    vi.advanceTimersByTime(5000);

    expect(park).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(parked.parked).toBe(false);
  });

  it('parks once the linger expires and resumes on the next mount', () => {
    const { parked, park, resume } = harness(1000);
    parked.mount();
    parked.connected();

    parked.unmount();
    vi.advanceTimersByTime(1000);
    expect(park).toHaveBeenCalledTimes(1);
    expect(parked.parked).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(park).toHaveBeenCalledTimes(1);

    parked.mount();
    expect(resume).toHaveBeenCalledTimes(1);
    expect(parked.parked).toBe(false);
    parked.mount();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('starts the linger when the subscription lands on an unmounted terminal', () => {
    const { parked, park, resume } = harness(1000);
    parked.connected();

    vi.advanceTimersByTime(999);
    expect(park).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(park).toHaveBeenCalledTimes(1);

    parked.mount();
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('treats a reconnect as a fresh subscription', () => {
    const { parked, park, resume } = harness(1000);
    parked.connected();
    vi.advanceTimersByTime(1000);
    expect(park).toHaveBeenCalledTimes(1);

    parked.connected();
    expect(parked.parked).toBe(false);
    parked.mount();
    expect(resume).not.toHaveBeenCalled();

    parked.unmount();
    vi.advanceTimersByTime(1000);
    expect(park).toHaveBeenCalledTimes(2);
  });

  it('never parks or resumes after dispose', () => {
    const { parked, park, resume } = harness(1000);
    parked.mount();
    parked.connected();

    parked.unmount();
    parked.dispose();
    vi.advanceTimersByTime(5000);
    parked.mount();
    parked.unmount();
    vi.advanceTimersByTime(5000);

    expect(park).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does nothing for a terminal that never connected', () => {
    const { parked, park, resume } = harness(1000);
    parked.mount();
    parked.unmount();
    vi.advanceTimersByTime(5000);
    parked.mount();

    expect(park).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
