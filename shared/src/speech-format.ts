// Makes agent text sound natural when read aloud by browser speech synthesis.
const spell = (s: string) => s.split('').join(' ');

function formatTime(h: number, m: number): string {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

export function formatForSpeech(text: string): string {
  return (
    text
      // strip markdown emphasis and citation brackets that sound odd aloud
      .replace(/[*_`#]/g, '')
      .replace(/\[(?:source|Source):?\s*[^\]]*\]/g, '')
      // 24h times -> 12h
      .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, h: string, m: string) =>
        formatTime(Number(h), Number(m)),
      )
      // flight numbers and booking/account refs (2 letters + digits) are read character by character
      .replace(/\b([A-Z]{2})(\d{3,4})\b/g, (_, l: string, d: string) => `${spell(l)} ${spell(d)}`)
      // currency
      .replace(/\$(\d+)(?:\.(\d{2}))?/g, (_, d: string, c?: string) =>
        c && c !== '00' ? `${d} dollars and ${Number(c)} cents` : `${d} dollars`,
      )
      .replace(/\s{2,}/g, ' ')
      .trim()
  );
}
