// Title-only hints run locally. They never create categories or save a video.
const topics = [
  { names: ['наука', 'научное', 'познавательное', 'science'], words: ['науч*', 'физик*', 'хими*', 'математ*', 'эксперимент*', 'исследован*', 'астроном*', 'электрич*', 'молекул*', 'атом*', 'планет*', 'космос', 'космич*', 'science', 'physics', 'chemistry', 'math*', 'experiment*', 'space'] },
  { names: ['природа', 'nature'], words: ['природ*', 'животн*', 'звер*', 'птиц*', 'насеком*', 'динозавр*', 'лес', 'океан*', 'морск*', 'растени*', 'вулкан*', 'nature', 'animal*', 'wildlife', 'dinosaur*'] },
  { names: ['мультфильмы', 'мультики', 'cartoons'], words: ['мульт*', 'cartoon*', 'animation', 'animated', 'pixar', 'disney', 'смешарик*', 'фиксик*', 'лунтик', 'три кота', 'маша и медведь', 'синий трактор'] },
  { names: ['творчество', 'поделки', 'рукоделие', 'crafts'], words: ['рисуем', 'рисован*', 'рисунок', 'лепк*', 'пластилин*', 'поделк*', 'оригами', 'аппликаци*', 'мастер класс', 'рукодел*', 'craft*', 'drawing', 'paint*', 'diy'] },
  { names: ['космос', 'астрономия', 'space'], words: ['космос', 'космич*', 'планет*', 'астроном*', 'галактик*', 'вселенн*', 'ракета', 'луна', 'марс', 'сатурн', 'звезд*', 'space', 'planet*', 'galaxy', 'astronom*', 'rocket*'] },
  { names: ['животные', 'звери', 'animals'], words: ['животн*', 'звер*', 'птиц*', 'насеком*', 'котенок', 'котята', 'кошк*', 'собак*', 'щенок', 'щенки', 'тигр*', 'слон*', 'жираф*', 'динозавр*', 'animal*', 'wildlife', 'dinosaur*', 'kitten*', 'pupp*'] },
  { names: ['машины', 'транспорт', 'cars', 'vehicles'], words: ['машин*', 'автомобил*', 'грузовик*', 'трактор*', 'поезд*', 'самолет*', 'автобус*', 'транспорт*', 'car', 'cars', 'truck*', 'train*', 'vehicle*'] },
  { names: ['музыка', 'песни', 'music'], words: ['музык*', 'песен*', 'песня', 'песни', 'поем', 'пианино', 'гитар*', 'оркестр*', 'music', 'song*', 'singing', 'piano', 'guitar*'] },
  { names: ['рисование', 'drawing'], words: ['рисуем', 'рисован*', 'рисунок', 'карандаш*', 'акварел*', 'drawing', 'draw', 'paint*'] },
  { names: ['английский', 'english'], words: ['английск*', 'english', 'alphabet', 'abc', 'phonics'] }
];

function words(text) {
  return typeof text === 'string' ? text.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) ?? [] : [];
}

function stem(word) {
  if (word.length <= 4) return word;
  return word.replace(/(?:иями|ями|ами|ого|ему|ому|ыми|ими|иях|ах|ях|ов|ев|ей|ия|ие|ии|ий|ый|ой|ая|яя|ое|ее|ые|ую|юю|ою|ею|ам|ям|ом|ем|ы|и|а|я|у|ю|е|о)$/u, '');
}

function matches(tokens, phrase) {
  const prefix = phrase.endsWith('*');
  const parts = words(phrase);
  if (!parts.length) return false;
  return tokens.some((_, start) => parts.every((part, offset) => {
    const token = tokens[start + offset];
    if (!token) return false;
    return prefix && offset === parts.length - 1 ? token.startsWith(part) : stem(token) === stem(part);
  }));
}

const stopWords = new Set(['и', 'или', 'для', 'про', 'о', 'об', 'по', 'на', 'в', 'с', 'со', 'the', 'and', 'for', 'of']);

export function suggestTags(title, categories) {
  const tokens = words(title);
  if (!tokens.length) return [];
  return categories.filter(category => category.id !== 'Другое').map((category, order) => {
    const nameWords = words(category.name);
    const meaningful = nameWords.filter(word => !stopWords.has(word));
    // Arbitrary user-created tags match their names too, including Russian word endings.
    const named = meaningful.length && meaningful.every(word => matches(tokens, word));
    const related = topics.filter(topic => topic.names.some(name => matches(nameWords, name)))
      .flatMap(topic => topic.words);
    const hits = related.filter(word => matches(tokens, word)).length;
    return { id: category.id, score: (named ? 4 : 0) + Math.min(hits, 3), order };
  }).filter(result => result.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 9).map(result => result.id);
}

export function createTagSuggestions({ request, onChange = () => {}, delay = 1500 } = {}) {
  let manual = false;
  let suggested = [];
  let loading = false;
  let source = 'local';
  let unavailable = false;
  let key;
  let revision = 0;
  let timer;
  const cache = new Map();
  const snapshot = () => ({ suggested: [...suggested], apply: !manual, loading, source, unavailable });
  return {
    update(title, categories) {
      const next = JSON.stringify([title.trim(), categories.map(c => [c.id, c.name])]);
      if (next === key) return snapshot();
      key = next;
      const current = ++revision;
      clearTimeout(timer);
      suggested = suggestTags(title, categories);
      source = 'local';
      unavailable = false;
      loading = Boolean(request && title.trim().length >= 3);
      if (loading) {
        timer = setTimeout(async () => {
          try {
            let result = cache.get(next);
            if (!result) {
              result = await request(title.trim());
              if (result?.enabled) {
                if (!Array.isArray(result.tags) || result.tags.length > 9 || result.tags.some(id => !categories.some(c => c.id === id && id !== 'Другое'))) throw new Error('Invalid suggested tags');
                if (cache.size >= 50) cache.delete(cache.keys().next().value);
                cache.set(next, result);
              }
            }
            if (current !== revision) return;
            if (result?.enabled) { suggested = [...new Set(result.tags)]; source = 'llm'; }
          } catch {
            if (current !== revision) return;
            unavailable = true;
          }
          if (current !== revision) return;
          loading = false;
          onChange(snapshot());
        }, delay);
      }
      return snapshot();
    },
    markManual() { manual = true; },
    accept() { manual = false; return [...suggested]; },
    dispose() { revision++; clearTimeout(timer); }
  };
}
