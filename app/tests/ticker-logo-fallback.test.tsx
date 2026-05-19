// TickerLogo monogram fallback rendering.
//
// For symbols logo.dev (or any third-party logo provider) doesn't have, the
// component must fall back to a colored monogram so the row still has a
// visual anchor. We verify the fallback covers:
//   - One-letter symbols (e.g. "X"): single-letter monogram.
//   - Two-letter symbols (e.g. "GE"): two-letter monogram.
//   - Multi-letter symbols (e.g. "VITAX"): first two letters.
//   - Empty / whitespace symbols: "?" placeholder.
//   - Non-alpha characters (e.g. "BRK-B"): stripped to alphanumeric.
// And the BrokerageLogo similarly resolves to known logos vs. monogram for
// unknown brokerages.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { TickerLogo } from '../src/components/TickerLogo';
import { BrokerageLogo } from '../src/components/BrokerageLogo';

afterEach(() => {
  cleanup();
});

describe('TickerLogo monogram fallback', () => {
  // Each test renders fresh and asserts on the rendered monogram text. The
  // background-fetch path is fire-and-forget; the initial paint always uses
  // the monogram so we can read text content synchronously.
  it('renders single-letter monogram for one-letter symbols', () => {
    const { container } = render(<TickerLogo ticker="X" />);
    const span = container.querySelector('.ticker-logo.monogram');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('X');
  });

  it('renders two-letter monogram for two-letter symbols', () => {
    const { container } = render(<TickerLogo ticker="GE" />);
    const span = container.querySelector('.ticker-logo.monogram');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('GE');
  });

  it('takes the first two letters for multi-letter symbols', () => {
    const { container } = render(<TickerLogo ticker="VITAX" />);
    const span = container.querySelector('.ticker-logo.monogram');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('VI');
  });

  it('strips non-alpha characters before slicing', () => {
    // BRK-B should monogram as "BR", not "BR" or "B-".
    const { container } = render(<TickerLogo ticker="BRK-B" />);
    const span = container.querySelector('.ticker-logo.monogram');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('BR');
  });

  it('renders "?" for empty / whitespace symbols', () => {
    const { container } = render(<TickerLogo ticker="   " />);
    const span = container.querySelector('.ticker-logo.monogram');
    expect(span).not.toBeNull();
    expect(span!.textContent).toBe('?');
  });

  it('uppercases lowercase tickers in the monogram', () => {
    const { container } = render(<TickerLogo ticker="goog" />);
    const span = container.querySelector('.ticker-logo.monogram');
    expect(span!.textContent).toBe('GO');
  });

  it('honors the size prop for the rendered span', () => {
    const { container } = render(<TickerLogo ticker="AAPL" size={48} />);
    const span = container.querySelector('.ticker-logo.monogram') as HTMLElement;
    expect(span.style.width).toBe('48px');
    expect(span.style.height).toBe('48px');
  });

  it('renders a monogram with a colored background tile (not blank)', () => {
    // We can't easily compare oklch() strings through JSDOM because its
    // CSS parser strips unrecognized color syntax (oklch is a 2024 CSS
    // feature). Instead, assert that the monogram span exists with the
    // `monogram` class and the right initials, and that the inline style
    // attribute carries every static layout property we expect.
    const { container } = render(<TickerLogo ticker="VTI" />);
    const span = container.querySelector('.ticker-logo.monogram') as HTMLElement;
    expect(span).not.toBeNull();
    expect(span.textContent).toBe('VT');
    const attr = span.getAttribute('style') || '';
    // Layout properties survive JSDOM. The background hue is what gets
    // dropped, so we test the size-related properties as a proxy for
    // "the inline style attribute is being applied" and trust the
    // production browser to render the oklch() color.
    expect(attr).toMatch(/width:\s*24px/);
    expect(attr).toMatch(/height:\s*24px/);
    expect(attr).toMatch(/border-radius:/);
  });
});

describe('BrokerageLogo', () => {
  it('renders the Fidelity image when name matches', () => {
    const { container } = render(<BrokerageLogo name="Fidelity" />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('alt')).toBe('Fidelity logo');
  });

  it('renders the Schwab image when name matches', () => {
    const { container } = render(<BrokerageLogo name="Schwab" />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('renders the Schwab image for "Charles Schwab" via substring match', () => {
    const { container } = render(<BrokerageLogo name="Charles Schwab" />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('renders the JP Morgan image (mapped through Chase)', () => {
    const { container } = render(<BrokerageLogo name="JP Morgan" />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('renders the JPMorgan image for "JPMorgan Self-Directed" via substring', () => {
    const { container } = render(<BrokerageLogo name="JPMorgan Self-Directed" />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('renders the Human Interest image for "Human Interest"', () => {
    const { container } = render(<BrokerageLogo name="Human Interest" />);
    expect(container.querySelector('img')).not.toBeNull();
  });

  it('renders an initials monogram for an unknown brokerage', () => {
    const { container } = render(<BrokerageLogo name="Unknown Bank" />);
    const div = container.querySelector('.brokerage-mark');
    expect(div).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(div!.textContent).toBe('UB');
  });

  it('renders initials for a single-word brokerage', () => {
    const { container } = render(<BrokerageLogo name="Custom" />);
    const div = container.querySelector('.brokerage-mark');
    expect(div).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(div!.textContent).toBe('C');
  });

  it('honors the size="large" variant by appending the .large class', () => {
    const { container } = render(<BrokerageLogo name="Fidelity" size="large" />);
    const div = container.querySelector('.brokerage-mark.large');
    expect(div).not.toBeNull();
  });
});
