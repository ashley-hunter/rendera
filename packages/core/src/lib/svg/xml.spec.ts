import { parseXml, textContent } from './xml';

describe('parseXml', () => {
  it('parses nested elements, attributes, and self-closing tags', () => {
    const root = parseXml('<svg width="100" height="50"><g><rect x="1" y="2"/></g></svg>');
    expect(root.tag).toBe('svg');
    expect(root.attrs).toEqual({ width: '100', height: '50' });
    expect(root.children).toHaveLength(1);
    expect(root.children[0].tag).toBe('g');
    expect(root.children[0].children[0].tag).toBe('rect');
    expect(root.children[0].children[0].attrs).toEqual({ x: '1', y: '2' });
  });

  it('strips namespace prefixes on tags and xlink attributes', () => {
    const root = parseXml('<svg xmlns:xlink="x"><use xlink:href="#a"/></svg>');
    expect(root.children[0].tag).toBe('use');
    expect(root.children[0].attrs.href).toBe('#a');
  });

  it('skips comments, CDATA, PIs, and the DOCTYPE', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!DOCTYPE svg><svg><!-- c --><style><![CDATA[.a{}]]></style></svg>'
    );
    expect(root.tag).toBe('svg');
    expect(root.children[0].tag).toBe('style');
    expect(root.children[0].text).toBe('.a{}');
  });

  it('decodes entities and numeric character references', () => {
    const root = parseXml('<t label="a&amp;b &#65; &#x42;">x &lt; y</t>');
    expect(root.attrs.label).toBe('a&b A B');
    expect(root.text).toBe('x < y');
  });

  it('collects descendant text content in order', () => {
    const root = parseXml('<text><tspan>Hello</tspan></text>');
    expect(textContent(root)).toBe('Hello');
  });

  it('throws on mismatched closing tags', () => {
    expect(() => parseXml('<a></b>')).toThrow();
  });

  it('throws on unclosed elements', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
  });
});
