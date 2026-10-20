# Follow Studio

Instagram'ın JSON ZIP arşivindeki takipçi ve takip edilen listelerini karşılaştıran, Violentmonkey üzerinde çalışan bir userscript. Arayüz Türkçedir. Çalışırken yapay zekâ servisi veya API anahtarı kullanmaz.

## Kurulum

1. Tarayıcına Violentmonkey eklentisini kur.
2. [Userscripti yükle](https://raw.githubusercontent.com/kakcil/instagram-follow-studio/main/instagram-follow-studio.user.js) bağlantısını aç ve Violentmonkey'in kurulum ekranını onayla. Bağlantı kod olarak açılırsa dosyayı indirip Violentmonkey'e içe aktar.
3. Instagram'a giriş yap ve sayfayı yenile. Sağ alttaki **Follow Studio** düğmesine tıkla. Panel kendiliğinden açılmaz.

Aynı işi yapan birden fazla scripti eşzamanlı çalıştırma. Önceki sürüm kuruluysa onu güncelle veya devre dışı bırak.

## Kullanım

1. Instagram veri dışa aktarımında **takipçiler ve takip edilenler**, **tüm zamanlar** ve **JSON** seçeneklerini seçip ZIP'i indir.
2. Panelden ZIP'i seç. `followers.json` / `followers_*.json` ve `following.json` dosyaları okunur; diğer arşiv dosyaları işlenmez.
3. Listeyi incele. **ASC / DESC**, takip etme tarihine göre sıralar. **Hide**, hesabı kalıcı korumaya alır. **×**, hesabı o listeden çıkarır; Instagram'da takipten çıkarmaz.
4. İşlemler arası beklemeyi ayarla; varsayılan **5 saniye**. **Başlat**, seçili bölümün uygun hesaplarını sırayla işler. **Durdur**, sonraki işlemleri keser; gönderilmiş bir işlemi geri almaz.

### Listenin anlamı

```text
Adaylar = ZIP'teki takip edilenler − ZIP'teki takipçiler
İşlem listesi = adaylar − korunanlar − bulunamayanlar − listeden kaldırılanlar
```

Karşılaştırma **yalnızca yüklediğin ZIP'e** dayanır. Bir hesabın ZIP'te takipçiler arasında bulunmaması, şu anda seni takip etmediğini tek başına kanıtlamaz. Eksik veya tarih aralığı kısıtlı bir dışa aktarım yanlış adaylar üretebilir; script arşivin eksiksizliğini doğrulayamaz. Instagram'daki güncel takipçi durumunu ayrıca sorgulamaz.

Yeni ZIP, önceki ana listeyi ve çalışma sonuçlarını değiştirir. Korunan ve bulunamayan hesaplar saklanır. Son liste, panel tekrar açıldığında ZIP yeniden seçilmeden gösterilir.

### Bölümler ve çalışma şekli

- **Takip bırak:** ZIP karşılaştırmasından gelen adaylar. Başarıyla işlenen veya zaten takip edilmeyen hesaplar listeden kaldırılır.
- **Korunanlar:** Hide ile eklenen hesaplar. İşlemden önce tekrar kontrol edilir ve takipten çıkarılmaz.
- **Dondurulmuş hesaplar:** Profil düğmesi bulunamayan hesaplar. Bu ad bir kesinlik ifade etmez: yavaş bağlantı, sayfa değişikliği veya erişim sorunu da aynı sonucu üretebilir. Bu bölüm seçiliyken Başlat, yalnızca buradaki ve mevcut ZIP'e göre uygun hesapları yeniden dener.

Iframe yöntemi önce görünmez bir işlem alanı dener; çalışan scriptle bağlantı kurulamazsa arka plan sekmesine geçer. Profil düğmesi araması, işlem scripti yüklendikten sonra en fazla 2 saniyedir. Sayfanın yüklenmesi, iframe bağlantısı ve takipten çıkarma sonucunun beklenmesi toplam süreyi uzatabilir. Seçilen bekleme, bu işlemlerin arasına uygulanır; toplam süre garantisi değildir. Süre tahmini ilk işlemden sonra ölçülen süreyle güncellenir.

Elle liste girişi kapalı bir bölümde bulunur. Elle girilen adlar da mevcut ZIP'e ve korunan hesaplara göre süzülür; ZIP olmadan çalıştırılmaz. Arşivde profil fotoğrafı bağlantısı varsa satırda gösterilir; eksik fotoğraflar ayrıca toplanmaz.

## Gizlilik

- Bu repo örnek kullanıcı listesi, kişisel ZIP, işlem günlüğü, ekran görüntüsü veya giriş bilgisi içermez. Testler yapay veriler kullanır.
- ZIP, tarayıcıda yerel olarak okunur. Scriptin veri toplama sunucusu veya analitik servisi yoktur.
- Ayrıştırılan listeler, ZIP dosya adı, korunan/bulunamayan hesaplar ve son çalışma özeti Violentmonkey'in yerel script depolamasında tutulur. ZIP'in tamamı saklanmaz.
- İşlemler mevcut Instagram oturumunu ve Instagram sayfalarını kullanır. Fotoğraf bağlantısına tıklarsan ilgili adrese istek gönderilir. Userscript yöneticisi güncellemeleri GitHub üzerinden denetleyebilir.
- **Liste hafızasını sıfırla**, ana listeyi ve çalışma özetini temizler; korunan ve bulunamayan kayıtları korur. Tüm kayıtları silmek için Violentmonkey'in script depolamasını temizle.

Script, Instagram'ın görünen düğmelerini kullanır; arayüz veya dil değişiklikleri çalışmasını etkileyebilir. Giriş ekranlarını, doğrulamaları veya işlem kısıtlarını aşmaya çalışmaz. Instagram ile bağlantılı resmi bir ürün değildir.

## Geliştirme

Node.js 22.13+:

```sh
npm ci
npm test
npm run check
```

Testler, jsdom içinde sahte Violentmonkey depolaması ve yapay JSON ZIP kullanır. Gerçek Instagram hesabına bağlanmaz veya takip işlemi gerçekleştirmez. Scriptin tarayıcıda çalışması için npm gerekmez.

## English

Follow Studio is a Turkish-language Violentmonkey userscript for comparing Instagram JSON exports and processing an unfollow queue. Install the [userscript](https://raw.githubusercontent.com/kakcil/instagram-follow-studio/main/instagram-follow-studio.user.js), open Instagram, click the bottom-right launcher and import an all-time JSON export containing followers and following.

The queue is based on **following minus followers in that export**, excluding protected, unavailable and removed entries. It does not verify live follower status or archive completeness. Imports replace the main queue; protected and unavailable records persist locally. The repository contains no personal exports or real account fixtures. No AI service or API key is required.

## Lisans

[MIT](LICENSE)
