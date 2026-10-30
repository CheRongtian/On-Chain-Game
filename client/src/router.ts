import { createRouter, createWebHistory } from 'vue-router';
import LobbyView from './views/LobbyView.vue';
import RoomView from './views/RoomView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'lobby', component: LobbyView },
    { path: '/chain', name: 'chain', component: () => import('./views/ChainView.vue') },
    {
      path: '/transactions/:hash',
      name: 'transaction',
      component: () => import('./views/ChainView.vue'),
    },
    { path: '/history', name: 'history', component: () => import('./views/HistoryView.vue') },
    {
      path: '/history/:matchId',
      name: 'replay',
      component: () => import('./views/ReplayView.vue'),
    },
    { path: '/rooms/:matchId', name: 'room', component: RoomView },
    {
      path: '/rooms/:matchId/battle',
      name: 'battlefield',
      component: () => import('./views/BattleView.vue'),
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
  scrollBehavior: () => ({ top: 0 }),
});
