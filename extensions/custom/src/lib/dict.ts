/** Chuẩn hoá từ tra: chữ thường, bỏ khoảng trắng thừa và dấu câu ở hai đầu, nháy cong thành nháy thẳng. */
export function wordKey(raw: string): string | null {
	let s = raw.trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ');
	try { s = decodeURIComponent(s); } catch { return null; }
	s = s.replace(/^[^a-z]+|[^a-z]+$/g, '');
	if (!s || s.length > 60 || !/^[a-z][a-z' -]*$/.test(s)) return null;
	return s;
}

/** Mã ngôn ngữ của Wiktionary (vi, id) từ mã của app (vi-VN, id-ID). Mặc định tiếng Việt. */
export const dictLang = (v: unknown): string => {
	const code = String(v || '').slice(0, 2).toLowerCase();
	return /^(vi|id)$/.test(code) ? code : 'vi';
};
