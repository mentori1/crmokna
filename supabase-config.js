// Публичная конфигурация Supabase (URL + anon key).
// Безопасно для браузера: доступ к данным защищён RLS — без входа
// (Supabase Auth) ни одна строка не видна.
window.SUPABASE_URL = 'https://piokomyxclpjscddhemr.supabase.co';
window.SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBpb2tvbXl4Y2xwanNjZGRoZW1yIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4NDg3MTEsImV4cCI6MjA5ODQyNDcxMX0.N34KspvDsk7EmL4nNnHF-gvdoeGhXl5ifoomGsWxlWA';

// Токен DaData (Suggestions API) для подсказок адреса в заказе/клиенте.
// Бесплатный, безопасен для браузера (это «API-ключ», НЕ «секретный ключ»).
// Работает из браузера (CORS), без привязки к домену — заводится сразу.
// Получить: dadata.ru → Личный кабинет → API-ключ. Без токена поле — обычный текст.
window.DADATA_TOKEN = '';
