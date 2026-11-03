import { katakanaToRomaji } from '../retrieval/jaPhonetic.js';
import { JA_GLOSSARY } from '../retrieval/jaGlossary.js';
const vowel = (c: string) => /[aeiou]/.test(c);
function englishPhones(word: string): string { return word.toLowerCase().replace(/er$/g, 'a').replace(/ea/g, 'e').replace(/ph/g, 'f').replace(/th|sh|ch/g, 's').replace(/ck/g, 'k').replace(/qu/g, 'k').replace(/c(?=[eiy])/g, 's').replace(/g(?=[eiy])/g, 'j').replace(/l/g, 'r').replace(/([aeiou])r(?=[^aeiou]|$)/g, '$1').replace(/([^aeiou])\1+/g, '$1'); }
function kanaPhones(kana: string): string { return katakanaToRomaji(kana).replace(/sh|ch/g, 's').replace(/l/g, 'r').replace(/([^aeiou])\1+/g, '$1'); }
/** Vowel insertion is common in borrowed Japanese words; consonant changes remain expensive. */
export function phoneticObjectDistance(kana: string, english: string): number {
    const a = kanaPhones(kana), b = englishPhones(english);
    if (!a || !b || a.length > 64 || b.length > 64)
        return Infinity;
    let previous = Array.from({ length: b.length + 1 }, (_, j) => [...b.slice(0, j)].reduce((sum, c) => sum + (vowel(c) ? 0.25 : 1), 0));
    for (let i = 1; i <= a.length; i++) {
        const current = [previous[0]! + (vowel(a[i - 1]!) ? 0.25 : 1)];
        for (let j = 1; j <= b.length; j++)
            current[j] = Math.min(previous[j]! + (vowel(a[i - 1]!) ? 0.25 : 1), current[j - 1]! + (vowel(b[j - 1]!) ? 0.25 : 1), previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : vowel(a[i - 1]!) && vowel(b[j - 1]!) ? 0.5 : 1));
        previous = current;
    }
    return previous[b.length]! / Math.max(a.length, b.length);
}
/** Existing lexical glossary segments are semantic groups. Phonetic retrieval collisions are not interchangeable proof terms. */
export function phoneticObjectGroups(source: string, tokens: readonly string[]): string[][] {
    const groups: string[][] = [];
    let rest = source;
    const consumed = new Set<string>();
    const lexical = JA_GLOSSARY.filter(([term]) => /^[\p{Script=Katakana}ー]+$/u.test(term)).sort((a, b) => b[0].length - a[0].length);
    while (rest) {
        const entry = lexical.find(([term]) => rest.startsWith(term));
        if (!entry)
            break;
        const admitted = tokens.filter(t => entry[1].some(stem => t === stem || stem.length >= 4 && t.startsWith(stem)));
        if (!admitted.length)
            return [[]];
        groups.push(admitted);
        admitted.forEach(t => consumed.add(t));
        rest = rest.slice(entry[0].length);
    }
    if (!rest)
        return groups;
    const ranked = tokens.filter(t => !consumed.has(t)).map(token => ({ token, distance: phoneticObjectDistance(rest, token) })).sort((a, b) => a.distance - b.distance || a.token.localeCompare(b.token));
    const best = ranked[0];
    if (!best || best.distance > 0.10)
        return [...groups, []];
    // Near ties only survive when they are inflections of the same English stem.
    const close = ranked.filter(x => x.distance <= best.distance + 0.025);
    if (close.some(x => !x.token.startsWith(best.token) && !best.token.startsWith(x.token)))
        return [...groups, []];
    return [...groups, close.map(x => x.token)];
}
