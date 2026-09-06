import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import StoredStrategyLab from './StoredStrategyLab.jsx';

it('does not invent initial performance or use supplied synthetic chart data', () => {
  const html = renderToStaticMarkup(<StoredStrategyLab candles={{ NIFTY50: Array(300).fill({ close: 100 }) }} />);
  expect(html).toContain('Loading saved audit');
  expect(html).toContain('No random signals');
  expect(html).not.toContain('Sharpe');
  expect(html).not.toContain('71%');
});
