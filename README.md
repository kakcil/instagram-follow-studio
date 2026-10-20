# Follow Studio

Instagram'ın JSON ZIP arşivindeki takipçi ve takip edilen listelerini karşılaştıran bağımsız bir **Chrome / Brave eklentisi**. Violentmonkey veya mağaza kurulumu gerektirmez. Arayüz Türkçedir. Çalışırken yapay zekâ servisi veya API anahtarı kullanmaz. Önceki userscript sürümü de repoda bulunur.

## Chrome / Brave kurulumu — mağaza gerekmez

1. [Eklenti ZIP'ini indir](https://github.com/kakcil/instagram-follow-studio/releases/latest/download/follow-studio-chrome.zip) ve bir klasöre çıkar.
2. Chrome'da `chrome://extensions`, Brave'de `brave://extensions` sayfasını aç.
3. Sağ üstte **Geliştirici modu** seçeneğini aç.
4. **Paketlenmemiş öğe yükle / Load unpacked** düğmesine tıkla. ZIP'ten çıkan, içinde `manifest.json` bulunan **follow-studio** klasörünü seç.
5. Instagram'a giriş yap ve açık Instagram sayfanı yenile. Sağ alttaki **Follow Studio** düğmesine veya Instagram açıkken tarayıcı araç çubuğundaki eklenti simgesine tıkla.

Alternatif: Bu repoyu indirip aynı ekranda **extension** klasörünü seç. npm veya derleme gerekmez; çalıştırılabilir dosyalar repoda hazırdır. ZIP'in kendisini yükleme ekranında seçme.

Eklenti yalnızca `www.instagram.com` erişimi ve yerel depolama izni ister. Liste işleme başlaması için panelde **Başlat** düğmesine basılmalıdır. Aynı anda yalnızca bir Instagram sekmesi işlem çalıştırabilir. Ana sekmeyi kapatmak veya yenilemek işlemi durdurur ve ona ait arka plan sekmelerini kapatır.

**Güncelleme:** Yeni ZIP'i indir, mevcut eklenti klasöründeki dosyaları yenileriyle değiştir ve eklentiler sayfasındaki **Yenile** düğmesine bas. Aynı klasörü kullan; eklentiyi kaldırıp yeniden kurmak yerel kayıtları silebilir. Mağaza dışı sürüm otomatik güncelleme yapmaz.

**Userscriptten geçiş:** Önceki scripti Violentmonkey'de devre dışı bırak. Eklentinin depolaması ayrıdır: ZIP'i yeniden yükle ve korumak istediğin hesapları Başlat'tan önce yeniden Hide ile ekle. Eski scriptin kayıtları otomatik taşınmaz.

## Alternatif: Violentmonkey userscripti

1. Tarayıcına Violentmonkey eklentisini kur.
2. [Userscripti yükle](https://raw.githubusercontent.com/kakcil/instagram-follow-studio/main/instagram-follow-studio.user.js) bağlantısını aç ve Violentmonkey'in kurulum ekranını onayla. Bağlantı kod olarak açılırsa dosyayı indirip Violentmonkey'e içe aktar.
3. Instagram'a giriş yap ve sayfayı yenile. Sağ alttaki **Follow Studio** düğmesine tıkla. Panel kendiliğinden açılmaz.

Aynı işi yapan script ile bağımsız eklentiyi birlikte çalıştırma.

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
- Ayrıştırılan listeler, ZIP dosya adı, korunan/bulunamayan hesaplar ve son çalışma özeti eklentide `chrome.storage.local` içinde; userscript sürümünde Violentmonkey depolamasında tutulur. ZIP'in tamamı saklanmaz. Chrome'un senkronize depolaması kullanılmaz.
- İşlemler mevcut Instagram oturumunu ve Instagram sayfalarını kullanır. Fotoğraf bağlantısına tıklarsan ilgili adrese istek gönderilir. Bağımsız eklenti uzak kod indirmez; userscript yöneticisi userscript güncellemelerini GitHub üzerinden denetleyebilir.
- **Liste hafızasını sıfırla**, ana listeyi ve çalışma özetini temizler; korunan ve bulunamayan kayıtları korur. Tüm yerel kayıtları silmek için bağımsız eklentiyi kaldır veya userscript sürümünde Violentmonkey'in script depolamasını temizle.

Script, Instagram'ın görünen düğmelerini kullanır; arayüz veya dil değişiklikleri çalışmasını etkileyebilir. Giriş ekranlarını, doğrulamaları veya işlem kısıtlarını aşmaya çalışmaz. Instagram ile bağlantılı resmi bir ürün değildir.

## Geliştirme

Node.js 22.13+:

```sh
npm ci
npm run build
npm test
npm run check
npm run package
```

Testler jsdom içinde yapay JSON ZIP, sahte Chrome API'leri ve userscript depolaması kullanır. Gerçek Instagram hesabına bağlanmaz veya takip işlemi gerçekleştirmez. Tarayıcıda çalıştırmak için npm gerekmez.

Ortak arayüz ve ZIP karşılaştırması `instagram-follow-studio.user.js` dosyasındadır. `scripts/build-extension.cjs`, Chrome depolama/iletişim adaptörünü kullanarak `extension/content.js` dosyasını üretir. Üretilen dosyayı doğrudan düzenleme. `extension/background.js`, işlem sekmelerinin sahipliğini ve her tıklamadan önce güncel ZIP/koruma kontrolünü yönetir. Paket komutu yalnızca izin verilen dört eklenti dosyasını `dist/follow-studio-chrome.zip` içine ekler.

## English

Follow Studio is a Turkish-language Chrome/Brave extension for comparing Instagram JSON exports and processing an unfollow queue. No Monkey extension or store listing is required. [Download the extension](https://github.com/kakcil/instagram-follow-studio/releases/latest/download/follow-studio-chrome.zip), extract it, open `chrome://extensions` (Brave: `brave://extensions`), enable Developer mode and choose **Load unpacked** → the extracted **follow-studio** folder containing `manifest.json`. Reload Instagram and click the launcher. You can also load this repository's **extension** folder directly.

Updates are manual: replace files in the same installed folder, then click Reload on the extensions page. Disable the previous userscript before using the extension. Its local data does not migrate automatically; reimport your ZIP and recreate protected accounts before starting. The [Violentmonkey userscript](https://raw.githubusercontent.com/kakcil/instagram-follow-studio/main/instagram-follow-studio.user.js) remains available as an alternative.

The queue is based on **following minus followers in that export**, excluding protected, unavailable and removed entries. It does not verify live follower status or archive completeness. Imports replace the main queue; protected and unavailable records persist locally. The repository contains no personal exports or real account fixtures. No AI service or API key is required.

## Lisans

[MIT](LICENSE)
