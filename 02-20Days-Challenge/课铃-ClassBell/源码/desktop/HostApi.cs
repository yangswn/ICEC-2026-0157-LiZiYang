using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace ClassBell
{
    internal static class HostApi
    {
        public static int Port;
        public static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        private static readonly HttpClient Client = new HttpClient { Timeout = TimeSpan.FromSeconds(25) };

        public static string BaseUrl
        {
            get { return "http://127.0.0.1:" + Port; }
        }

        public static async Task<string> GetJsonAsync(string path)
        {
            var response = await Client.GetAsync(BaseUrl + path);
            var text = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
                throw new Exception("HTTP " + (int)response.StatusCode + ": " + text);
            return text;
        }

        /// <summary>
        /// 读取任意文本响应（导出日志、导出备份这类非 JSON 接口）。
        /// </summary>
        public static async Task<string> GetTextAsync(string path)
        {
            var response = await Client.GetAsync(BaseUrl + path);
            var text = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
                throw new Exception("HTTP " + (int)response.StatusCode + ": " + text);
            return text;
        }

        public static async Task<string> PostJsonAsync(string path, object payload)
        {
            var body = new StringContent(Json.Serialize(payload), Encoding.UTF8, "application/json");
            var response = await Client.PostAsync(BaseUrl + path, body);
            var text = await response.Content.ReadAsStringAsync();
            if (!response.IsSuccessStatusCode)
                throw new Exception("HTTP " + (int)response.StatusCode + ": " + text);
            return text;
        }

        public static Dictionary<string, object> ParseObject(string json)
        {
            if (string.IsNullOrWhiteSpace(json)) return new Dictionary<string, object>();
            return Json.Deserialize<Dictionary<string, object>>(json);
        }

        public static string Str(Dictionary<string, object> map, string key, string fallback = "")
        {
            if (map == null || !map.ContainsKey(key) || map[key] == null) return fallback;
            return Convert.ToString(map[key]);
        }

        public static bool Bool(Dictionary<string, object> map, string key, bool fallback = false)
        {
            if (map == null || !map.ContainsKey(key) || map[key] == null) return fallback;
            try { return Convert.ToBoolean(map[key]); } catch { return fallback; }
        }
    }
}
