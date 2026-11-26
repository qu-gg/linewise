import DOMPurify from 'dompurify';
import { marked } from 'marked';

export function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }), {
    ALLOWED_TAGS: [
      'p',
      'br',
      'hr',
      'pre',
      'code',
      'blockquote',
      'strong',
      'em',
      'del',
      'ul',
      'ol',
      'li',
      'a',
      'h1',
      'h2',
      'h3',
      'h4',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
    ],
    ALLOWED_ATTR: ['href', 'title'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
