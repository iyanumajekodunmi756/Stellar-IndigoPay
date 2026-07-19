export interface SEP0007Params {
  destination: string;       // Required
  amount?: string;           // Optional — if absent, let user enter
  memo?: string;
  memo_type?: 'text' | 'id' | 'hash' | 'return';
  asset_code?: string;       // Default: XLM
  asset_issuer?: string;     // Required if asset_code != XLM
  message?: string;
  callback?: string;         // URL to redirect after payment
  network_passphrase?: string; // For testnet/mainnet distinction
}

export function parseSEP0007Params(url: string | null): Partial<SEP0007Params> {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    // Accept both web+stellar:pay and web+stellar://pay forms
    const protocol = parsed.protocol; // includes trailing ':'
    const host = parsed.hostname;
    if (!protocol.includes('web+stellar') || host !== 'pay') {
      return {};
    }
    return {
      destination: parsed.searchParams.get('destination') || '',
      amount: parsed.searchParams.get('amount') || undefined,
      memo: parsed.searchParams.get('memo') || undefined,
      memo_type: (parsed.searchParams.get('memo_type') as SEP0007Params['memo_type']) || undefined,
      asset_code: parsed.searchParams.get('asset_code') || undefined,
      asset_issuer: parsed.searchParams.get('asset_issuer') || undefined,
      message: parsed.searchParams.get('message') || undefined,
      callback: parsed.searchParams.get('callback') || undefined,
      network_passphrase: parsed.searchParams.get('network_passphrase') || undefined,
    };
  } catch (e) {
    return {};
  }
}
