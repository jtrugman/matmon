// Tests for the column-mapping wizard inside AddAccountView.
// When a CSV doesn't match any known brokerage importer we should land on the
// 'map' step with auto-guessed dropdowns populated from the CSV's header row,
// not on the review step with zero transactions.

import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AddAccountView } from '../src/views/AddAccountView';

const UNKNOWN_CSV = `transaction_date,kind,ticker,units,unit_price
2024-08-15,buy,AAPL,10,180.50
2024-08-10,sell,VTI,3,245.00
2024-07-15,sell,AAPL,5,175.20
2024-06-01,buy,BND,12,72.50`;

function makeFile(text: string, name = 'unknown.csv'): File {
  // happy-dom's File polyfill needs a text() method that yields the contents.
  const file = new File([text], name, { type: 'text/csv' });
  // Some File polyfills don't implement .text(); provide a fallback.
  if (typeof (file as any).text !== 'function') {
    (file as any).text = () => Promise.resolve(text);
  }
  return file;
}

async function uploadCsv(text: string) {
  const { container } = render(<AddAccountView />);
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  const file = makeFile(text);
  // userEvent.upload would be cleaner but the input is hidden; fire change directly.
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    fireEvent.change(input);
    // Allow file.text() promise + the setState that follows to resolve.
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
  });
}

describe('Column-mapping wizard', () => {
  it('routes unknown CSVs to the mapper step instead of zero-row review', async () => {
    await uploadCsv(UNKNOWN_CSV);
    expect(await screen.findByText(/Map your columns/i)).toBeInTheDocument();
    expect(screen.queryByText(/Name this account/i)).toBeNull();
  });

  it('shows the CSV headers in every column dropdown', async () => {
    await uploadCsv(UNKNOWN_CSV);
    await screen.findByText(/Map your columns/i);
    const dateSelect = screen.getByLabelText(/Date column/i) as HTMLSelectElement;
    const optionLabels = Array.from(dateSelect.options).map(o => o.value);
    for (const header of ['transaction_date', 'kind', 'ticker', 'units', 'unit_price']) {
      expect(optionLabels).toContain(header);
    }
    expect(optionLabels).toContain(''); // the "(none)" option
  });

  it('auto-guesses date and price columns from header keywords', async () => {
    await uploadCsv(UNKNOWN_CSV);
    await screen.findByText(/Map your columns/i);
    const dateSelect = screen.getByLabelText(/Date column/i) as HTMLSelectElement;
    expect(dateSelect.value).toBe('transaction_date');
    const priceSelect = screen.getByLabelText(/Price column/i) as HTMLSelectElement;
    expect(priceSelect.value).toBe('unit_price');
  });

  it('renders the live CSV preview alongside the field map', async () => {
    await uploadCsv(UNKNOWN_CSV);
    await screen.findByText(/Map your columns/i);
    expect(screen.getByText(/CSV preview/i)).toBeInTheDocument();
    // The header "transaction_date" appears both in the CSV preview table and
    // in the column dropdowns; ensure there is at least one rendering of it.
    expect(screen.getAllByText('transaction_date').length).toBeGreaterThan(0);
  });

  it('Continue button is disabled until both required fields are mapped', async () => {
    await uploadCsv(UNKNOWN_CSV);
    await screen.findByText(/Map your columns/i);
    const continueBtn = screen.getByRole('button', { name: /Continue/i });
    // The default auto-guess maps both date and a kind-keyword for action, so it should be enabled.
    expect(continueBtn).toBeEnabled();
    // Clear the date field; button should disable.
    const dateSelect = screen.getByLabelText(/Date column/i) as HTMLSelectElement;
    await userEvent.selectOptions(dateSelect, '');
    expect(continueBtn).toBeDisabled();
  });

  it('exposes a brokerage label input defaulting to "Custom"', async () => {
    await uploadCsv(UNKNOWN_CSV);
    await screen.findByText(/Map your columns/i);
    const labelInput = screen.getByLabelText(/Brokerage label/i) as HTMLInputElement;
    expect(labelInput.value).toBe('Custom');
  });

  it('continuing with a valid map advances to the review step with parsed rows', async () => {
    await uploadCsv(UNKNOWN_CSV);
    await screen.findByText(/Map your columns/i);
    // Force the symbol mapping so the parsed transactions carry a symbol.
    const symbolSelect = screen.getByLabelText(/Symbol column/i) as HTMLSelectElement;
    await userEvent.selectOptions(symbolSelect, 'ticker');
    const continueBtn = screen.getByRole('button', { name: /Continue/i });
    await userEvent.click(continueBtn);
    // Now on the review step.
    expect(await screen.findByText(/Name this account/i)).toBeInTheDocument();
    // The review inferences should mention the parsed transaction count somewhere.
    expect(screen.getAllByText(/parsed/i).length).toBeGreaterThan(0);
  });

  it('remembers the mapping for the same header shape on a second import', async () => {
    await uploadCsv(UNKNOWN_CSV);
    await screen.findByText(/Map your columns/i);
    const symbolSelect = screen.getByLabelText(/Symbol column/i) as HTMLSelectElement;
    await userEvent.selectOptions(symbolSelect, 'ticker');
    await userEvent.click(screen.getByRole('button', { name: /Continue/i }));
    await screen.findByText(/Name this account/i);
    // The map for this shape should now be in localStorage.
    const stored = localStorage.getItem('matmon.columnMaps.v1');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    const key = JSON.stringify(['kind', 'ticker', 'transaction_date', 'unit_price', 'units'].sort());
    expect(parsed[key]).toBeTruthy();
    expect(parsed[key].date).toBe('transaction_date');
    expect(parsed[key].symbol).toBe('ticker');
  });
});
