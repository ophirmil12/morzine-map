"""Static reader for a Nuxt 2 `window.__NUXT__=(function(...){...}(...))` payload.

Parses the small JS subset Nuxt/devalue emits (literals, object/array literals,
identifier refs, property assignments, `return`). Nothing is executed.
"""
import sys, json, re

ID_START = re.compile(r'[A-Za-z_$]')
ID_CHAR = re.compile(r'[A-Za-z0-9_$]')
NUM = re.compile(r'-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?')
UNDEF = object()


class P:
    def __init__(self, s):
        self.s, self.i, self.env = s, 0, {}

    def ws(self):
        s, i = self.s, self.i
        while i < len(s) and s[i] in ' \t\r\n':
            i += 1
        self.i = i

    def peek(self, t):
        self.ws(); return self.s.startswith(t, self.i)

    def eat(self, t):
        self.ws()
        if not self.s.startswith(t, self.i):
            raise SyntaxError(f'expected {t!r} at {self.i}: {self.s[self.i:self.i+80]!r}')
        self.i += len(t)

    def ident(self):
        self.ws(); j = self.i
        if not ID_START.match(self.s[j]):
            raise SyntaxError(f'ident at {j}: {self.s[j:j+60]!r}')
        j += 1
        while j < len(self.s) and ID_CHAR.match(self.s[j]):
            j += 1
        name = self.s[self.i:j]; self.i = j; return name

    def string(self):
        q = self.s[self.i]; j = self.i + 1; out = []
        s = self.s
        while s[j] != q:
            c = s[j]
            if c == '\\':
                n = s[j+1]
                if n == 'u':
                    if s[j+2] == '{':
                        k = s.index('}', j); out.append(chr(int(s[j+3:k], 16))); j = k + 1; continue
                    out.append(chr(int(s[j+2:j+6], 16))); j += 6; continue
                if n == 'x':
                    out.append(chr(int(s[j+2:j+4], 16))); j += 4; continue
                out.append({'n': '\n', 't': '\t', 'r': '\r', 'b': '\b', 'f': '\f', 'v': '\v', '0': '\0'}.get(n, n)); j += 2; continue
            out.append(c); j += 1
        self.i = j + 1
        txt = ''.join(out)
        # join UTF-16 surrogate pairs produced by 🗺 style escapes
        return txt.encode('utf-16', 'surrogatepass').decode('utf-16')

    def expr(self):
        self.ws(); s = self.s; c = s[self.i]
        if c in '"\'':
            return self.string()
        if c == '{':
            self.i += 1; d = {}
            while not self.peek('}'):
                self.ws(); c2 = s[self.i]
                if c2 in '"\'':
                    k = self.string()
                elif c2.isdigit():
                    m = NUM.match(s, self.i); k = m.group(); self.i = m.end()
                else:
                    k = self.ident()
                self.eat(':'); d[k] = self.expr()
                if self.peek(','):
                    self.eat(',')
            self.eat('}'); return d
        if c == '[':
            self.i += 1; a = []
            while not self.peek(']'):
                a.append(self.expr())
                if self.peek(','):
                    self.eat(',')
            self.eat(']'); return a
        m = NUM.match(s, self.i)
        if m and (c.isdigit() or c in '-.'):
            self.i = m.end(); t = m.group()
            return float(t) if any(x in t for x in '.eE') else int(t)
        if s.startswith('void 0', self.i):
            self.i += 6; return None
        if s.startswith('Array(', self.i):
            self.i += 6; n = self.expr(); self.eat(')'); return [None] * n
        if s.startswith('new Date(', self.i):
            self.i += 9; v = self.expr(); self.eat(')'); return {'$date': v}
        name = self.ident()
        lit = {'true': True, 'false': False, 'null': None, 'undefined': None,
               'NaN': None, 'Infinity': None}
        if name in lit:
            return lit[name]
        if name not in self.env:
            raise NameError(f'{name} at {self.i}')
        v = self.env[name]
        # member access on a ref (rare in expressions)
        return v

    def target_assign(self):
        name = self.ident(); obj = self.env; key = name
        while True:
            self.ws(); c = self.s[self.i]
            if c == '.':
                self.i += 1; obj = obj[key]; key = self.ident()
            elif c == '[':
                self.i += 1; obj = obj[key]; k = self.expr(); self.eat(']')
                key = int(k) if isinstance(k, int) else k
            else:
                break
        self.eat('=')
        v = self.expr()
        if isinstance(obj, list):
            while len(obj) <= key:
                obj.append(None)
        obj[key] = v


def parse(code):
    a = code.index('(function(') + len('(function(')
    b = code.index(')', a)
    params = code[a:b].split(',')
    body_start = code.index('{', b) + 1
    # args: the final '(...)' before '));' at end
    p = P(code)
    # find body end: scan statements from body_start
    p.i = body_start
    stmts_start = body_start
    # first parse args, which sit after the body; locate them by scanning the body with the parser
    # we must parse the body twice: first skip to get args position, then evaluate.
    # Skip body by matching braces while respecting strings.
    s = code; i = body_start; depth = 1
    while depth:
        ch = s[i]
        if ch in '"\'':
            q = ch; i += 1
            while s[i] != q:
                i += 2 if s[i] == '\\' else 1
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
        i += 1
    body_end = i - 1
    p.i = body_end + 1; p.eat('(')
    args = []
    while not p.peek(')'):
        args.append(p.expr())
        if p.peek(','):
            p.eat(',')
    p.env = dict(zip(params, args + [None] * (len(params) - len(args))))
    p.i = stmts_start
    while True:
        p.ws()
        if p.s.startswith('return', p.i):
            p.i += 6; return p.expr()
        p.target_assign(); p.eat(';')


if __name__ == '__main__':
    src = open(sys.argv[1], encoding='utf-8').read()
    i = src.index('window.__NUXT__=')
    j = src.index('</script>', i)
    out = parse(src[i:j])
    json.dump(out, open(sys.argv[2], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('ok', list(out.keys()))
