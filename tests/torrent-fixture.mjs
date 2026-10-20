import { createHash } from 'node:crypto';

function bencode(value) {
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(value.length + ':'), value]);
  if (typeof value === 'string') return bencode(Buffer.from(value));
  if (typeof value === 'number') return Buffer.from('i' + value + 'e');
  if (Array.isArray(value))
    return Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]);
  return Buffer.concat([
    Buffer.from('d'),
    ...Object.keys(value)
      .sort()
      .flatMap((key) => [bencode(key), bencode(value[key])]),
    Buffer.from('e'),
  ]);
}

export function torrentFixture(name = 'nivra-test.txt') {
  const data = Buffer.from('Nivra integration test fixture.\n');
  const info = {
    length: data.length,
    name,
    'piece length': 16384,
    pieces: createHash('sha1').update(data).digest(),
    private: 1,
  };
  return {
    bytes: bencode({ info }),
    hash: createHash('sha1').update(bencode(info)).digest('hex'),
    name,
    data,
  };
}
