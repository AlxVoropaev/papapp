export const defaultCategories = ['Наука', 'Природа', 'Мультфильмы', 'Творчество', 'Другое'];
export const fallbackCategory = 'Другое';

export function categoryList(records = []) {
  const result = new Map(defaultCategories.map(name => [name, { id: name, name }]));
  for (const record of records) {
    if (record.active) result.set(record.id, { id: record.id, name: record.name });
    else result.delete(record.id);
  }
  return [...result.values()];
}

export function categoryName(records, id) {
  return records.find(category => category.id === id)?.name ?? fallbackCategory;
}

export function validCategoryName(input) {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!name || name.length > 40) throw new Error('Название темы должно содержать от 1 до 40 символов.');
  if (name.toLocaleLowerCase('ru') === 'все') throw new Error('Название «Все» уже используется для всей полки.');
  return name;
}

export function videoTags(video, records) {
  const tags = Array.isArray(video.categories) ? video.categories : [video.category];
  return [...new Set(tags)].filter(id => id !== fallbackCategory && records.some(c => c.id === id));
}

export function selectedTags(data, records) {
  const input = data.categories ?? (data.category ? [data.category] : []);
  if (!Array.isArray(input) || input.length > 9 || input.some(id => typeof id !== 'string')) {
    throw new Error('Можно выбрать не больше 9 тем для одного видео.');
  }
  return videoTags({ categories: input }, records);
}
