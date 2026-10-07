window.__ModuleLoader__.load({
  id: 'dsh-plugin-chatgpt-subscription',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const buttonStyle = { padding: '7px 12px', border: '1px solid currentColor', borderRadius: 7, cursor: 'pointer', background: 'transparent', color: 'inherit' };
    const time = (value) => value ? new Date(value).toLocaleString() : '未知';
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        function Card() {
          const [data, setData] = React.useState(null);
          const [busy, setBusy] = React.useState('');
          const [error, setError] = React.useState('');
          const [confirmLogout, setConfirmLogout] = React.useState(false);
          const alive = React.useRef(false);
          const sequence = React.useRef(0);
          async function call(method) {
            const id = ++sequence.current;
            const result = await ctx.connection.rpc.call('/chatgpt-subscription', method, {});
            if (!result.ok) throw new Error(result.error?.message || '账号服务暂不可用');
            if (alive.current && sequence.current === id) setData(result.value);
            return result.value;
          }
          React.useEffect(() => {
            alive.current = true;
            let timer, cancelled = false;
            async function refresh() {
              try { await call('status'); }
              catch { if (!cancelled) setError('无法连接订阅账号服务。安装更新后请重启桌面端。'); }
              if (!cancelled) timer = setTimeout(refresh, 2500);
            }
            void refresh();
            return () => { cancelled = true; alive.current = false; clearTimeout(timer); };
          }, []);
          async function action(method) {
            if (busy) return;
            setBusy(method); setError('');
            try { await call(method); }
            catch (e) { if (alive.current) setError(e.message); }
            finally { if (alive.current) { setBusy(''); setConfirmLogout(false); } }
          }
          const login = data?.login ?? {};
          const pending = login.state === 'pending' || login.state === 'requesting';
          const usage = data?.usage;
          const button = (label, method, disabled = false) => h('button', { type: 'button', style: buttonStyle, disabled: !!busy || disabled, onClick: () => action(method) }, busy === method ? '处理中…' : label);
          function windowRow(label, value) {
            if (!value) return h('div', { style: { marginTop: 10 } }, label, '：暂无数据');
            const remaining = value.remainingRatio;
            const duration = value.windowSeconds ? `（${Math.round(value.windowSeconds / 3600)} 小时窗口）` : '';
            return h('div', { style: { marginTop: 12 } },
              h('div', null, label, duration, '：', remaining === null ? '剩余额度未知' : `剩余 ${Math.round(remaining * 100)}%`),
              remaining !== null && h('progress', { max: 1, value: remaining, style: { width: '100%', height: 10 }, 'aria-label': `${label}剩余额度` }),
              h('div', { style: { opacity: 0.7, fontSize: 12 } }, '重置时间：', time(value.resetAt)));
          }
          let authorizationUrl;
          try {
            const url = new URL(login.verificationUrl);
            if (url.origin === 'https://auth.openai.com' && url.pathname === '/codex/device') authorizationUrl = url.href;
          } catch {}
          return h('section', { 'aria-label': 'ChatGPT 订阅账号', style: { padding: '16px 0', display: 'grid', gap: 12 } },
            h('strong', null, 'ChatGPT 订阅登录与额度'),
            h('p', { style: { margin: 0, opacity: 0.75, fontSize: 13 } }, '使用 ChatGPT 账号授权 Codex；不是 API 余额。设备码登录不需要本机接收入站回调。'),
            h('div', { role: 'status', 'aria-live': 'polite' }, !data ? '正在读取账号状态…' : data.authenticated ? `${data.account?.email || '已保存账号'} · ${data.account?.planType || '套餐未知'}${data.account?.expired ? ' · 访问令牌已过期，可刷新额度或重新授权' : ''}` : '尚未登录 ChatGPT 订阅'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              button(data?.authenticated ? '重新授权' : '登录 ChatGPT', 'login/start', pending || !data),
              button('刷新额度', 'usage/refresh', !data?.authenticated || pending),
              data?.authenticated && h('button', { type: 'button', style: buttonStyle, disabled: !!busy, onClick: () => setConfirmLogout(true) }, '退出登录')),
            confirmLogout && h('div', { role: 'alert', style: { border: '1px solid currentColor', padding: 12, borderRadius: 8 } },
              h('p', null, '确定删除本机保存的订阅凭据？若与 Codex CLI 共用凭据，它也会退出。'),
              button('确认退出', 'logout'), ' ', h('button', { type: 'button', style: buttonStyle, onClick: () => setConfirmLogout(false) }, '保留登录')),
            pending && h('div', { style: { padding: 16, border: '1px solid currentColor', borderRadius: 8 } },
              login.state === 'requesting' ? h('p', null, '正在获取设备码…') : h(React.Fragment, null,
                h('p', null, '在官方授权页面输入以下设备码：'),
                h('code', { style: { fontSize: 24, letterSpacing: 3, userSelect: 'all' } }, login.userCode),
                h('p', null, authorizationUrl ? h('a', { href: authorizationUrl, target: '_blank', rel: 'noopener noreferrer' }, '打开 OpenAI 授权页面 ↗') : '授权地址无法验证，请检查管理员的登录端点设置。'),
                h('p', { style: { fontSize: 12 } }, '有效期至 ', time(login.expiresAt), '。授权后这里会自动更新；不要向他人提供设备码。')),
              button('取消登录', 'login/cancel')),
            login.state === 'success' && h('div', { role: 'status' }, '授权成功，凭据已保存。点击“刷新额度”查询当前限额。'),
            (error || data?.error || login.error) && h('div', { role: 'alert', style: { color: '#dc6666' } }, error || data?.error || login.error),
            data?.authenticated && h('div', { style: { padding: 12, border: '1px solid #8885', borderRadius: 8 } },
              h('strong', null, 'Codex 订阅额度'),
              usage?.state === 'loading' ? h('p', { role: 'status' }, '正在查询…') : h(React.Fragment, null, windowRow('主要额度', usage?.primary), windowRow('次要额度', usage?.secondary)),
              usage?.error && h('p', { role: 'alert' }, usage.error),
              h('p', { style: { fontSize: 12, opacity: 0.7, marginBottom: 0 } }, usage?.updatedAt ? `更新于 ${time(usage.updatedAt)}。额度窗口以服务端返回为准。` : '点击“刷新额度”获取实际数据；未知额度不会显示为 100%。')));
        }
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({ name: 'settings.models.provider-card', key: 'chatgpt-subscription' }, Card));
      },
    };
  },
});
