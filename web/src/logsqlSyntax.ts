// Split only actual pipe separators, keeping regexes, quoted strings and subqueries intact.
export function splitLogPipes(query: string): string[] | null {
  query = query.trimEnd();
  if (query.endsWith(';')) query = query.slice(0, -1);
  const parts: string[] = [];
  const stack: string[] = [];
  let comment = false;
  let quote = '',
    escaped = false,
    start = 0;
  for (let index = 0; index < query.length; index++) {
    const char = query[index];
    if (comment) {
      if (char === '\n') comment = false;
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\' && quote !== '`') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '#') {
      comment = true;
      continue;
    }
    if ('"\'`'.includes(char)) {
      quote = char;
      continue;
    }
    if ('([{'.includes(char)) stack.push(char);
    else if (')]}'.includes(char)) {
      if (stack.pop() !== ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[char])
        return null;
    } else if (char === '|' && stack.length === 0) {
      parts.push(query.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || stack.length) return null;
  parts.push(query.slice(start).trim());
  return parts;
}
