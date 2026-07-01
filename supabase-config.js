// Публичная конфигурация Supabase (URL + anon key).
// Безопасно для браузера: доступ к данным защищён RLS — без входа
// (Supabase Auth) ни одна строка не видна.
window.SUPABASE_URL = 'https://piokomyxclpjscddhemr.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpb2tvbXl4Y2xwanNjZGRoZW1yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDg3MTEsImV4cCI6MjA5ODQyNDcxMX0.N34KspvDsk7EmL4nNnHF-gvdoeGhXl5ifoomGsWxlWA';

// Ключ Яндекс.Карт для подсказок адреса (ymaps.SuggestView в браузере).
// ВАЖНО: нужен ключ продукта «JavaScript API и Геокодер (HTTP)» — НЕ отдельный
// «API Геокодера» и НЕ «Геосаджест». В настройках ключа добавить домен(ы), где
// крутится CRM (mentori.tech и адрес GitHub Pages), иначе Яндекс отвечает
// «Invalid API key». На localhost domain-restricted ключ всегда «invalid» —
// проверять только на боевом домене. Без валидного ключа поле — обычный текст.
window.YANDEX_SUGGEST_KEY = 'caf4257d-3c93-439a-bcbf-663fc7ba6f58';
