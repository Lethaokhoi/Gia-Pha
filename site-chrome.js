/**
 * Header / footer dùng chung cho blog, điều khoản, bài viết.
 * @param {{ active?: 'app' | 'blog' | '' }} [opts]
 */
export function mountSiteChrome(opts = {}) {
  const active = opts.active || "";
  const headerMount = document.getElementById("site-chrome-header");
  const footerMount = document.getElementById("site-chrome-footer");
  if (headerMount) headerMount.innerHTML = buildHeader(active);
  if (footerMount) footerMount.innerHTML = buildFooter();
}

function buildHeader(active) {
  const appCls = active === "app" ? " site-nav-link--active" : "";
  const blogCls = active === "blog" ? " site-nav-link--active" : "";
  return `<div class="site-header-inner">
      <a class="site-logo" href="index.html">
        <span class="site-logo-title">Gia phả</span>
        <span class="site-logo-tag">Quản lý dòng họ trực tuyến</span>
      </a>
      <nav class="site-nav" aria-label="Menu chính">
        <a class="site-nav-link${appCls}" href="index.html">Ứng dụng</a>
        <a class="site-nav-link${blogCls}" href="blog.html">Blog</a>
        <a class="site-nav-link site-nav-cta btn primary" href="index.html#cloud-auth-block">Dùng miễn phí</a>
      </nav>
    </div>`;
}

function buildFooter() {
  const year = new Date().getFullYear();
  return `<div class="site-footer-inner">
      <div class="site-footer-col">
        <p class="site-footer-brand">Gia phả</p>
        <p class="meta">Lưu cây phả hệ, ảnh chân dung, in sơ đồ — chia sẻ với họ hàng.</p>
      </div>
      <div class="site-footer-col">
        <p class="site-footer-heading">Liên kết</p>
        <ul class="site-footer-links">
          <li><a href="index.html">Mở ứng dụng</a></li>
          <li><a href="blog.html">Blog &amp; hướng dẫn</a></li>
        </ul>
      </div>
      <div class="site-footer-col">
        <p class="site-footer-heading">Pháp lý</p>
        <ul class="site-footer-links">
          <li><a href="terms.html">Điều khoản</a></li>
          <li><a href="privacy.html">Quyền riêng tư</a></li>
        </ul>
      </div>
    </div>
    <p class="site-footer-copy meta">© ${year} Gia phả. Dữ liệu do bạn sở hữu — xuất JSON bất cứ lúc nào.</p>`;
}
