/**
 * 浏览器半边：在左侧栏注册一个「网页版」入口，并把 chat.deepseek.com
 * 以整页 iframe 的形式放进主区域。
 *
 * 页面本身由 Host 的回环代理提供；登录态由 Host 记住并在每次加载时回填，
 * 所以用户只需要像用普通网站一样登录一次。
 */

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 词典命名空间。 */
    const NS = 'deepseekWebPanel';
    /** 左侧栏入口与主区域面板共用的 id。 */
    const PANEL_ID = 'deepseek-web';
    /** Host 同源状态路由，用来取得代理地址和登录状态。 */
    const STATUS_ROUTE = '/plugins/deepseek-web-panel/status';
    /** Host 同源登录同步路由（高级）。 */
    const SYNC_ROUTE = '/plugins/deepseek-web-panel/sync';

    /** 中英文案。 */
    const dictionaries = {
      zh: {
        panel: '网页版',
        title: 'DeepSeek 网页版',
        connecting: '正在连接…',
        unavailable: '面板暂时不可用',
        hint: '本地服务没有启动，可以点重试；仍然失败请看 Harness 日志。',
        retry: '重试',
        reload: '刷新',
        external: '在浏览器打开',
        help: '登录帮助',

        statusIn: '已登录',
        statusOut: '未登录',

        banner: '第一次使用请先登录。登录一次后会自动记住，以后打开直接进入。',
        bannerOk: '知道了',

        helpTitle: '登录说明',
        helpIntro: '这个面板就是你平时用的 DeepSeek 网页版，登录方式和官网一样。',
        step1: '在下面的页面输入手机号，点「发送验证码」。',
        step2: '把收到的验证码填进去，点「登录」。',
        step3: '登录成功后会自动记住，以后打开这个面板就能直接用。',
        helpNote:
          '微信扫码在这里用不了：微信只允许在 DeepSeek 官网扫码，面板的地址不在它的白名单里。'
          + '用手机号登录进的是同一个账号，聊天记录都在。',
        advanced: '高级：手动同步登录',
        advancedHint: '只有“明明登录了却每次都要重新登录”时才需要用到，会涉及一段代码。',
        close: '关闭',

        syncTitle: '手动同步登录（高级）',
        syncHint:
          '如果面板总是记不住登录，可以在真正的 chat.deepseek.com 页面按 F12 打开控制台，'
          + '运行下面这段代码复制登录凭据，再粘贴到这里。凭据只保存在本机。',
        copySnippet: '复制代码',
        copied: '已复制',
        tokenLabel: '登录凭据',
        tokenPlaceholder: '粘贴复制到的内容',
        apply: '保存并刷新',
        cancel: '取消',
        syncFailed: '同步失败',
        emptyToken: '请先粘贴登录凭据',
      },
      en: {
        panel: 'Web',
        title: 'DeepSeek Web',
        connecting: 'Connecting…',
        unavailable: 'The panel is unavailable',
        hint: 'The local service is not running. Try again, and check the Harness log if it keeps failing.',
        retry: 'Retry',
        reload: 'Reload',
        external: 'Open in browser',
        help: 'Sign-in help',

        statusIn: 'Signed in',
        statusOut: 'Not signed in',

        banner: 'Sign in once to use this panel. It is remembered, so later visits open straight into your account.',
        bannerOk: 'Got it',

        helpTitle: 'How to sign in',
        helpIntro: 'This panel is the same DeepSeek web app you use in a browser, and it signs in the same way.',
        step1: 'Enter your phone number in the page below and choose “Send code”.',
        step2: 'Type the code you received and choose “Sign in”.',
        step3: 'The sign-in is remembered, so later visits open straight into your account.',
        helpNote:
          'The WeChat QR code cannot work here: WeChat only allows it on the official DeepSeek domain,'
          + ' and this panel runs on a local address. Signing in by phone reaches the same account.',
        advanced: 'Advanced: sync a sign-in manually',
        advancedHint: 'Only needed when the panel keeps asking you to sign in. It involves a code snippet.',
        close: 'Close',

        syncTitle: 'Sync a sign-in manually (advanced)',
        syncHint:
          'If the panel never remembers your sign-in, open chat.deepseek.com, press F12 for the console,'
          + ' run the snippet below to copy your credentials, then paste them here. They stay on this machine.',
        copySnippet: 'Copy snippet',
        copied: 'Copied',
        tokenLabel: 'Credentials',
        tokenPlaceholder: 'Paste what you copied',
        apply: 'Save and reload',
        cancel: 'Cancel',
        syncFailed: 'Sync failed',
        emptyToken: 'Paste your credentials first',
      },
    };

    /** 在正式站点控制台运行，复制已有的登录凭据。 */
    const SNIPPET =
      'copy(JSON.stringify({token:JSON.parse(localStorage.userToken).value,'
      + 'id:(JSON.parse(localStorage["__appKit_userInfo"]).value||{}).id}))';

    const BORDER = 'var(--dsw-alias-border, rgba(127,127,127,0.28))';
    const MUTED = 'var(--dsw-alias-text-secondary, rgba(127,127,127,0.95))';
    const OK = 'var(--dsw-alias-success, #2f9e44)';
    const WARN = 'var(--dsw-alias-warning, #f08c00)';

    /**
     * 左侧栏图标：线框地球，读作「网络 / 网页」。
     * @param {{size?: number, active?: boolean}} props 显示尺寸与选中状态。
     * @returns {object} SVG 元素。
     */
    function Glyph({ size = 18, active = false }) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block', opacity: active ? 1 : 0.88 },
        },
        h('circle', { cx: 12, cy: 12, r: 8.4 }),
        h('ellipse', { cx: 12, cy: 12, rx: 4, ry: 8.4 }),
        h('path', { d: 'M4.1 9.2h15.8M4.1 14.8h15.8' }),
      );
    }

    /**
     * 通用小按钮。
     * @param {string} label 文案。
     * @param {Function} onClick 点击回调。
     * @returns {object} 按钮元素。
     */
    function toolButton(label, onClick) {
      return h(
        'button',
        {
          type: 'button',
          onClick,
          style: {
            border: `1px solid ${BORDER}`,
            background: 'transparent',
            color: 'inherit',
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 12,
            cursor: 'pointer',
          },
        },
        label,
      );
    }

    /**
     * 创建面板组件。
     * @param {Function} t 词典翻译函数。
     * @returns {Function} 可注册到 main 插槽的 React 组件。
     */
    function createPanel(t) {
      return function DeepSeekWebPanel() {
        const [origin, setOrigin] = React.useState(null);
        const [route, setRoute] = React.useState('/');
        const [failure, setFailure] = React.useState(false);
        const [signedIn, setSignedIn] = React.useState(null);
        const [reloadKey, setReloadKey] = React.useState(0);
        const [helpOpen, setHelpOpen] = React.useState(false);
        const [syncOpen, setSyncOpen] = React.useState(false);
        const [bannerDismissed, setBannerDismissed] = React.useState(false);

        /** 查询代理地址和登录状态；失败时给出可重试状态。 */
        const attempt = React.useCallback(() => {
          setFailure(false);
          fetch(STATUS_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
            .then((payload) => {
              const url = payload && typeof payload.url === 'string' ? payload.url : '';
              if (!url) throw new Error('proxy not started');
              setOrigin(url.replace(/\/$/, ''));
              setSignedIn(typeof payload.signedIn === 'boolean' ? payload.signedIn : null);
              // 恢复到上次停留的会话，而不是每次都回到首页。
              if (typeof payload.route === 'string' && payload.route.startsWith('/') && !payload.route.startsWith('//')) {
                setRoute(payload.route);
              }
            })
            .catch(() => {
              setOrigin(null);
              setFailure(true);
            });
        }, []);

        React.useEffect(() => {
          attempt();
        }, [attempt]);

        const source = origin ? `${origin}${route}` : null;
        const showBanner = Boolean(source) && signedIn === false && !bannerDismissed;

        return h(
          'div',
          {
            className: 'dwp-root',
            style: {
              display: 'flex',
              flexDirection: 'column',
              height: '100%',
              minHeight: 0,
              background: 'var(--dsw-alias-bg-base, transparent)',
            },
          },
          h(
            'header',
            {
              className: 'dwp-head',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                borderBottom: `1px solid ${BORDER}`,
                minHeight: 40,
                flex: '0 0 auto',
              },
            },
            h(Glyph, { size: 16 }),
            h('span', { style: { fontWeight: 600, fontSize: 13 } }, t('title')),
            signedIn === true
              ? h('span', { style: { color: OK, fontSize: 12 } }, t('statusIn'))
              : signedIn === false
                ? h('span', { style: { color: WARN, fontSize: 12 } }, t('statusOut'))
                : null,
            h('span', { style: { flex: '1 1 auto' } }),
            source ? toolButton(t('reload'), () => setReloadKey((key) => key + 1)) : null,
            source ? toolButton(t('external'), () => window.open(source, '_blank', 'noopener,noreferrer')) : null,
            toolButton(t('help'), () => setHelpOpen(true)),
          ),
          showBanner
            ? h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 10px',
                    fontSize: 12,
                    color: MUTED,
                    borderBottom: `1px solid ${BORDER}`,
                    background: 'var(--dsw-alias-bg-elevated, transparent)',
                  },
                },
                h('span', { style: { flex: '1 1 auto' } }, t('banner')),
                toolButton(t('bannerOk'), () => setBannerDismissed(true)),
              )
            : null,
          h(
            'div',
            { className: 'dwp-body', style: { position: 'relative', flex: '1 1 auto', minHeight: 0 } },
            source
              ? h('iframe', {
                  key: `${source}#${reloadKey}`,
                  src: source,
                  title: t('title'),
                  className: 'dwp-frame',
                  style: { border: '0', width: '100%', height: '100%', display: 'block', background: '#fff' },
                  sandbox:
                    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals',
                  allow: 'clipboard-read; clipboard-write',
                  referrerPolicy: 'no-referrer',
                })
              : h(
                  'div',
                  {
                    style: {
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 10,
                      color: MUTED,
                      fontSize: 13,
                    },
                  },
                  h('span', null, failure ? t('unavailable') : t('connecting')),
                  failure ? h('span', { style: { fontSize: 12 } }, t('hint')) : null,
                  toolButton(t('retry'), attempt),
                ),
            helpOpen
              ? h(LoginHelp, {
                  t,
                  onClose: () => setHelpOpen(false),
                  onAdvanced: () => {
                    setHelpOpen(false);
                    setSyncOpen(true);
                  },
                })
              : null,
            syncOpen && source
              ? h(SyncDialog, {
                  t,
                  onClose: () => setSyncOpen(false),
                  onSynced: () => {
                    setSyncOpen(false);
                    setReloadKey((key) => key + 1);
                    attempt();
                  },
                })
              : null,
          ),
        );
      };
    }

    /**
     * 登录说明：默认只讲步骤，高级入口折叠在底部。
     * @param {{t: Function, onClose: Function, onAdvanced: Function}} props 翻译、关闭与高级入口。
     * @returns {object} 弹窗元素。
     */
    function LoginHelp({ t, onClose, onAdvanced }) {
      return modal(t, {
        title: t('helpTitle'),
        onClose,
        children: [
          h('p', { style: { margin: 0, fontSize: 13, lineHeight: 1.7 } }, t('helpIntro')),
          h('ol', { style: { margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.9 } },
            h('li', null, t('step1')),
            h('li', null, t('step2')),
            h('li', null, t('step3')),
          ),
          h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.7, color: MUTED } }, t('helpNote')),
          h('hr', { style: { border: 'none', borderTop: `1px solid ${BORDER}`, margin: '2px 0' } }),
          h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.6, color: MUTED } }, t('advancedHint')),
          h('button', {
            type: 'button',
            onClick: onAdvanced,
            style: {
              alignSelf: 'flex-start',
              border: 'none',
              background: 'transparent',
              color: 'var(--dsw-alias-brand, #4d6bfe)',
              padding: 0,
              fontSize: 12,
              cursor: 'pointer',
              textDecoration: 'underline',
            },
          }, t('advanced')),
        ],
      });
    }

    /**
     * 手动同步弹窗（高级）。
     * @param {{t: Function, onClose: Function, onSynced: Function}} props 翻译、关闭与成功回调。
     * @returns {object} 弹窗元素。
     */
    function SyncDialog({ t, onClose, onSynced }) {
      const [text, setText] = React.useState('');
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [copied, setCopied] = React.useState(false);

      /** 提交凭据。 */
      const submit = () => {
        const value = text.trim();
        if (!value) {
          setError(t('emptyToken'));
          return;
        }
        setBusy(true);
        setError(null);
        fetch(SYNC_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value.startsWith('{') ? safeParse(value) : { token: value }),
        })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
          .then(() => onSynced())
          .catch((cause) => {
            setError(`${t('syncFailed')}: ${cause?.message ?? cause}`);
            setBusy(false);
          });
      };

      return modal(t, {
        title: t('syncTitle'),
        onClose,
        children: [
          h('p', { style: { margin: 0, fontSize: 12, lineHeight: 1.7, color: MUTED } }, t('syncHint')),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
            h('code', {
              style: {
                flex: '1 1 auto',
                fontSize: 11,
                padding: '6px 8px',
                borderRadius: 6,
                border: `1px solid ${BORDER}`,
                overflowX: 'auto',
                whiteSpace: 'nowrap',
                display: 'block',
              },
            }, SNIPPET),
            toolButton(copied ? t('copied') : t('copySnippet'), () => {
              void navigator.clipboard?.writeText(SNIPPET).then(() => setCopied(true)).catch(() => {});
            }),
          ),
          h('span', { style: { fontSize: 12, color: MUTED } }, t('tokenLabel')),
          h('textarea', {
            value: text,
            onChange: (event) => setText(event.target.value),
            placeholder: t('tokenPlaceholder'),
            rows: 3,
            style: {
              width: '100%',
              resize: 'vertical',
              fontFamily: 'inherit',
              fontSize: 12,
              padding: 8,
              borderRadius: 6,
              border: `1px solid ${BORDER}`,
              background: 'transparent',
              color: 'inherit',
            },
          }),
          error ? h('span', { style: { color: '#e5484d', fontSize: 12 } }, error) : null,
          h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
            toolButton(t('cancel'), onClose),
            h('button', {
              type: 'button',
              disabled: busy,
              onClick: submit,
              style: {
                border: '1px solid transparent',
                background: 'var(--dsw-alias-brand, #4d6bfe)',
                color: '#fff',
                borderRadius: 6,
                padding: '5px 10px',
                fontSize: 12,
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.7 : 1,
              },
            }, t('apply')),
          ),
        ],
      });
    }

    /**
     * 通用模态外壳。
     * @param {Function} t 翻译函数。
     * @param {{title: string, onClose: Function, children: object[]}} options 标题、关闭回调和内容。
     * @returns {object} 遮罩加卡片。
     */
    function modal(t, { title, onClose, children }) {
      return h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          style: {
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.42)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 30,
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) onClose();
          },
        },
        h(
          'section',
          {
            style: {
              width: 'min(560px, calc(100% - 40px))',
              maxHeight: 'calc(100% - 40px)',
              overflowY: 'auto',
              background: 'var(--dsw-alias-bg-elevated, #fff)',
              color: 'var(--dsw-alias-text-primary, #111)',
              border: `1px solid ${BORDER}`,
              borderRadius: 10,
              padding: 16,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              boxShadow: '0 12px 40px rgba(0,0,0,0.28)',
            },
          },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h('strong', { style: { fontSize: 14, flex: '1 1 auto' } }, title),
            h('button', {
              type: 'button',
              onClick: onClose,
              'aria-label': 'close',
              style: {
                border: 'none',
                background: 'transparent',
                color: MUTED,
                fontSize: 16,
                lineHeight: 1,
                cursor: 'pointer',
                padding: 4,
              },
            }, '×'),
          ),
          ...children,
        ),
      );
    }

    /** 宽松解析 JSON，失败时退回原始字符串。 */
    function safeParse(value) {
      try {
        return JSON.parse(value);
      } catch {
        return { token: value };
      }
    }

    return {
      inject: ['slots', 'locale'],
      /**
       * 注册词典、左侧栏入口和主区域面板。
       * @param {object} ctx Harness 页面插件上下文。
       * @returns {void}
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'deepseek-web-panel: dictionaries');
        const t = ctx.locale.bind(NS);
        const Panel = createPanel(t);

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 40,
          label: () => t('panel'),
          locale: NS,
        }, Glyph));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Panel));
      },
    };
  },
});
